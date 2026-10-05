/**
 * Web search and page reading for the companion. Search tries, in order: Brave Search API
 * (BRAVE_API_KEY), Tavily (TAVILY_API_KEY), Brave's public results page, then Wikipedia plus Google
 * News RSS. The first provider with results wins; none ever invents results.
 * Page reading refuses private, loopback and metadata addresses, re-checking every redirect.
 */
import dns from 'dns';
import net from 'net';
import { Logger, WebPort, WebResult } from '../types';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BODY = 1_500_000;
const MAX_TEXT = 12_000;
const TEXT_TYPES = /^(text\/html|text\/plain|application\/json|application\/xhtml\+xml|application\/xml|text\/xml|application\/rss\+xml)/i;

export interface WebPortOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: Logger;
  resolveHost?: (host: string) => Promise<string[]>;
  /** Tests only: allow loopback/private targets. */
  allowPrivateHosts?: boolean;
  /** Injected clock for cache/rate-limit tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || (/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i.exec(html) || [])[1] || '');
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<article\b[\s\S]*?<\/article>/i.exec(body) || /<main\b[\s\S]*?<\/main>/i.exec(body);
  if (main && stripTags(main[0]).length > 200) body = main[0];
  body = body.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/blockquote)\b[^>]*>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n• ');
  const text = decodeEntities(body.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…[truncated]' : text };
}

// ---------------------------------------------------------------------------
// Result parsers (defensive: layout drift yields [], never a throw)
// ---------------------------------------------------------------------------

export function parseBraveHtml(html: string): WebResult[] {
  const out: WebResult[] = [];
  const blocks = html.split(/<div class="snippet[^"]*"[^>]*data-type="web"/).slice(1);
  for (const b of blocks) {
    const href = /<a href="(https?:\/\/[^"]+)"/.exec(b)?.[1];
    if (!href || /^https?:\/\/(search\.brave\.com|imgs\.search\.brave\.com)/.test(href)) continue;
    const title = /class="title[^"]*"[^>]*title="([^"]*)"/.exec(b)?.[1] || /class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b)?.[1] || '';
    const snippet = /class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b)?.[1] || '';
    const t = stripTags(title);
    if (!t) continue;
    out.push({ title: clip(t, 160), url: decodeEntities(href), snippet: clip(stripTags(snippet), 300) });
  }
  return out;
}

export function parseNewsRss(xml: string): WebResult[] {
  const out: WebResult[] = [];
  for (const item of xml.split(/<item>/).slice(1)) {
    const title = stripTags((/<title>([\s\S]*?)<\/title>/.exec(item) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') || '');
    const link = stripTags((/<link>([\s\S]*?)<\/link>/.exec(item) || [])[1] || '');
    const date = stripTags((/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item) || [])[1] || '');
    if (title && /^https?:\/\//.test(link)) out.push({ title: clip(title, 160), url: link, snippet: date ? `News, ${date}` : 'News' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function ipv4Private(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return ipv4Private(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

/** Normalizes the odd IPv4 spellings browsers accept (2130706433, 0x7f.1, 017.0.0.1). */
function numericIpv4(host: string): string | null {
  if (!/^[0-9a-fx.]+$/i.test(host) || !/\d/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const nums = parts.map((p) => (/^0x[0-9a-f]+$/i.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : /^\d+$/.test(p) ? parseInt(p, 10) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let value = 0;
  const last = nums[nums.length - 1];
  for (let i = 0; i < nums.length - 1; i++) value = value * 256 + nums[i];
  value = value * 256 ** (5 - nums.length) + last;
  if (value > 0xffffffff) return null;
  return [24, 16, 8, 0].map((s) => (value >>> s) & 255).join('.');
}

async function assertPublicUrl(raw: string, resolve: (h: string) => Promise<string[]>, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs can be read');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('that address is private');
  }
  const literal = net.isIP(host) ? host : numericIpv4(host);
  if (literal) {
    if (isPrivateAddress(literal)) throw new Error('that address is private');
    return url;
  }
  const addrs = await resolve(host);
  if (!addrs.length) throw new Error('could not resolve host');
  if (addrs.some(isPrivateAddress)) throw new Error('that address is private');
  return url;
}

const defaultResolve = async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Google News RSS; with a country code the results are local to that country. */
export function newsUrl(q: string, region?: string): string {
  const base = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}`;
  return region && /^[A-Z]{2}$/.test(region) ? `${base}&hl=en-${region}&gl=${region}&ceid=${region}:en` : `${base}&hl=en`;
}

export function createWebPort(opts: WebPortOptions = {}): WebPort {
  // Set per search call; providers read it when building URLs.
  let regionNow: string | undefined;
  const doFetch = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const resolve = opts.resolveHost ?? defaultResolve;
  const log = opts.log;

  const get = (url: string, init: RequestInit = {}) =>
    doFetch(url, { ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'en', ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });

  type Provider = { name: string; run: (q: string, n: number) => Promise<WebResult[]> };
  const providers: Provider[] = [];
  const braveKey = (env.BRAVE_API_KEY || '').trim();
  if (braveKey) {
    providers.push({
      name: 'brave-api',
      run: async (q, n) => {
        const res = await get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
        return (data.web?.results || []).filter((r) => r.url && r.title).map((r) => ({ title: clip(stripTags(r.title!), 160), url: r.url!, snippet: clip(stripTags(r.description || ''), 300) }));
      },
    });
  }
  const tavilyKey = (env.TAVILY_API_KEY || '').trim();
  if (tavilyKey) {
    providers.push({
      name: 'tavily',
      run: async (q, n) => {
        const res = await get('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: n }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (data.results || []).filter((r) => r.url && r.title).map((r) => ({ title: clip(r.title!, 160), url: r.url!, snippet: clip((r.content || '').replace(/\s+/g, ' '), 300) }));
      },
    });
  }
  providers.push({
    name: 'brave-html',
    run: async (q) => {
      const res = await get(`https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`, { headers: { Accept: 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseBraveHtml(await res.text());
    },
  });
  providers.push({
    name: 'wikipedia+news',
    run: async (q, n) => {
      const [wiki, news] = await Promise.allSettled([
        get(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=3`).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = (await r.json()) as { pages?: Array<{ title: string; key: string; excerpt?: string; description?: string }> };
          return (data.pages || []).map((p) => ({ title: p.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`, snippet: clip(stripTags(p.description || p.excerpt || ''), 300) }));
        }),
        get(newsUrl(q, regionNow)).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return parseNewsRss(await r.text()).slice(0, 4);
        }),
      ]);
      const out = [...(wiki.status === 'fulfilled' ? wiki.value : []), ...(news.status === 'fulfilled' ? news.value : [])];
      if (!out.length && wiki.status === 'rejected' && news.status === 'rejected') throw new Error('wikipedia and news both failed');
      return out.slice(0, n);
    },
  });

  const news: Provider = {
    name: 'news',
    run: async (q, n) => {
      const r = await get(newsUrl(q, regionNow));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parseNewsRss(await r.text()).slice(0, n);
    },
  };
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; results: WebResult[] }>();
  const benchedUntil = new Map<string, number>();

  return {
    async search(query, limit, searchOpts = {}) {
      const q = String(query || '').trim().slice(0, 300);
      if (!q) throw new Error('empty query');
      const n = Math.max(1, Math.min(10, limit || 6));
      const kind = searchOpts.kind === 'news' ? 'news' : 'web';
      regionNow = searchOpts.region;
      const cacheKey = `${kind}:${regionNow || ''}:${n}:${q.toLowerCase()}`;
      const hit = cache.get(cacheKey);
      if (hit && now() - hit.at < 10 * 60_000) return hit.results;
      const chain = kind === 'news' ? [news, ...providers] : providers;
      const errors: string[] = [];
      for (const p of chain) {
        if ((benchedUntil.get(p.name) ?? 0) > now()) {
          errors.push(`${p.name}: resting after rate limit`);
          continue;
        }
        try {
          const results = await p.run(q, n);
          const seen = new Set<string>();
          const unique = results.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, n);
          if (unique.length) {
            cache.set(cacheKey, { at: now(), results: unique });
            if (cache.size > 200) cache.delete(cache.keys().next().value as string);
            return unique;
          }
          errors.push(`${p.name}: no results`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${p.name}: ${msg}`);
          if (/HTTP (429|403)/.test(msg)) benchedUntil.set(p.name, now() + 10 * 60_000);
          log?.warn('web search provider failed', { provider: p.name, error: msg });
        }
      }
      if (errors.every((e) => e.endsWith('no results') || e.endsWith('resting after rate limit')) && errors.some((e) => e.endsWith('no results'))) return [];
      throw new Error('web search unavailable: ' + errors.join('; ').slice(0, 300));
    },

    async fetch(rawUrl) {
      let url = await assertPublicUrl(rawUrl, resolve, Boolean(opts.allowPrivateHosts));
      let res: Response | undefined;
      for (let hop = 0; hop <= 5; hop++) {
        res = await doFetch(url.toString(), { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel().catch(() => undefined);
          if (hop === 5) throw new Error('too many redirects');
          url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString(), resolve, Boolean(opts.allowPrivateHosts));
          continue;
        }
        break;
      }
      if (!res) throw new Error('no response');
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status}`);
      }
      const ctype = res.headers.get('content-type') || 'text/html';
      if (!TEXT_TYPES.test(ctype)) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`unsupported content type ${ctype.split(';')[0]}`);
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
          if (total >= MAX_BODY) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      const buf = Buffer.concat(chunks).subarray(0, MAX_BODY);
      const latin = /charset=(iso-8859-1|latin1|windows-1252)/i.test(ctype) || /<meta[^>]+charset=["']?(iso-8859-1|windows-1252)/i.test(buf.subarray(0, 2048).toString('latin1'));
      const raw = buf.toString(latin ? 'latin1' : 'utf8');
      if (/html|xml/i.test(ctype)) {
        const { title, text } = htmlToText(raw);
        return { url: url.toString(), title: title || url.hostname, text };
      }
      const text = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) + '\n…[truncated]' : raw;
      return { url: url.toString(), title: url.hostname, text };
    },
  };
}
