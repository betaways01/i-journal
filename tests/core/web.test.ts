import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { createWebPort, decodeEntities, htmlToText, isPrivateAddress, parseBraveHtml, parseNewsRss } from '../../src/core/ports/web';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8');

test('parses real Brave result markup', () => {
  const r = parseBraveHtml(fixture('brave-results.html'));
  assert.ok(r.length >= 2, JSON.stringify(r));
  assert.equal(r[0].title, 'Compound Interest Calculator | Investor.gov');
  assert.match(r[0].url, /^https:\/\/www\.investor\.gov\//);
  assert.match(r[0].snippet, /compound interest/i);
  assert.deepEqual(parseBraveHtml('<html>changed layout</html>'), []);
  assert.deepEqual(parseBraveHtml('<div class="snippet x" data-type="web"><a href="javascript:x">'), []);
});

test('parses Google News RSS, skipping broken items', () => {
  const r = parseNewsRss(fixture('news.rss'));
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Lisbon rains disrupt morning traffic & flights - Daily Courier');
  assert.equal(r[1].title, 'Euro steady against the dollar - Reuters');
  assert.match(r[0].snippet, /News, Thu, 01 Oct 2026/);
  assert.deepEqual(parseNewsRss('garbage'), []);
});

test('entities and HTML to readable text', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#8212; &#x1F600; &nbsp;&hellip; &bogus;'), 'a & b <c> — 😀  … &bogus;');
  const { title, text } = htmlToText(
    '<html><head><title>Lisbon &ndash; Wiki</title><style>.x{}</style><script>alert(1)</script></head><body><nav>menu</nav><article><h1>Lisbon</h1><p>Capital of Portugal.</p><ul><li>One</li><li>Two</li></ul><p>' + 'More words here. '.repeat(20) + '</p></article><footer>foot</footer></body></html>'
  );
  assert.equal(title, 'Lisbon – Wiki');
  assert.match(text, /^Lisbon\nCapital of Portugal\.\n\n?• One\n?\n?• Two/);
  assert.doesNotMatch(text, /alert|menu|foot/);
  assert.match(htmlToText('<p>' + 'x'.repeat(20000) + '</p>').text, /…\[truncated\]$/);
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('fetch refuses private targets, odd IP spellings, credentials, other schemes, and private DNS answers', async () => {
  const web = createWebPort({ resolveHost: async (h) => (h === 'evil.example' ? ['10.0.0.5'] : h === 'mixed.example' ? ['8.8.8.8', '127.0.0.1'] : ['93.184.216.34']), fetchImpl: async () => new Response('should not be called') });
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://017700000001/',
    'http://127.1/',
    'http://evil.example/',
    'http://mixed.example/',
    'http://user:pass@example.com/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'not a url',
  ]) {
    await assert.rejects(web.fetch(url), (e: Error) => /private|only http|credentials|valid URL/.test(e.message), url);
  }
});

async function server(handler: http.RequestListener): Promise<{ base: string; close(): Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

test('fetch follows safe redirects, re-checks each hop, caps size, rejects binary, decodes latin1', async () => {
  const s = await server((req, res) => {
    const u = req.url || '';
    if (u === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Hello</title><main><p>' + 'Main content. '.repeat(30) + '</p></main>');
    } else if (u === '/r1') {
      res.writeHead(302, { location: '/r2' });
      res.end();
    } else if (u === '/r2') {
      res.writeHead(301, { location: '/page' });
      res.end();
    } else if (u === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (u === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/' });
      res.end();
    } else if (u === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('y'.repeat(3_000_000));
    } else if (u === '/bin') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF');
    } else if (u === '/latin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.from('<title>Caf\xe9</title><p>na\xefve</p>', 'latin1'));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const open = createWebPort({ allowPrivateHosts: true });
    const p = await open.fetch(s.base + '/r1');
    assert.equal(p.title, 'Hello');
    assert.equal(p.url, s.base + '/page');
    assert.match(p.text, /Main content/);
    await assert.rejects(open.fetch(s.base + '/loop'), /too many redirects/);
    await assert.rejects(open.fetch(s.base + '/bin'), /unsupported content type application\/pdf/);
    await assert.rejects(open.fetch(s.base + '/missing'), /HTTP 404/);
    const big = await open.fetch(s.base + '/big');
    assert.ok(big.text.length <= 12_020);
    const latin = await open.fetch(s.base + '/latin');
    assert.equal(latin.title, 'Café');
    assert.match(latin.text, /naïve/);
    // With the guard on, a public-looking first hop that redirects to metadata is refused at the hop.
    const guarded = createWebPort({
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: async (input: string | URL | Request) => {
        const u = String(input);
        if (u.startsWith('http://public.example/')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
        throw new Error('must not reach ' + u);
      },
    });
    await assert.rejects(guarded.fetch('http://public.example/start'), /private/);
  } finally {
    await s.close();
  }
});

test('search: provider chain falls through, keys pick API providers, no fabrication', async () => {
  const brave = fixture('brave-results.html');
  const news = fixture('news.rss');
  const seen: string[] = [];
  const mk = (routes: Record<string, () => Response>) => async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    seen.push(u.split('?')[0] + (init?.method === 'POST' ? ' POST' : ''));
    for (const [prefix, fn] of Object.entries(routes)) if (u.startsWith(prefix)) return fn();
    return new Response('nope', { status: 500 });
  };
  const keyless = createWebPort({ fetchImpl: mk({ 'https://search.brave.com/': () => new Response(brave) }) });
  const r = await keyless.search('compound interest formula', 5);
  assert.equal(r[0].title, 'Compound Interest Calculator | Investor.gov');
  assert.equal(seen[0], 'https://search.brave.com/search');

  seen.length = 0;
  const fallback = createWebPort({
    fetchImpl: mk({
      'https://search.brave.com/': () => new Response('<html>captcha</html>'),
      'https://en.wikipedia.org/': () => Response.json({ pages: [{ title: 'Lisbon', key: 'Lisbon', description: 'Capital of Portugal' }] }),
      'https://news.google.com/': () => new Response(news),
    }),
  });
  const r2 = await fallback.search('Lisbon', 6);
  assert.deepEqual(r2.map((x) => x.title), ['Lisbon', 'Lisbon rains disrupt morning traffic & flights - Daily Courier', 'Euro steady against the dollar - Reuters']);
  assert.equal(r2[0].url, 'https://en.wikipedia.org/wiki/Lisbon');

  const empty = createWebPort({
    fetchImpl: mk({
      'https://search.brave.com/': () => new Response('<html></html>'),
      'https://en.wikipedia.org/': () => Response.json({ pages: [] }),
      'https://news.google.com/': () => new Response('<rss></rss>'),
    }),
  });
  assert.deepEqual(await empty.search('zzqqxx', 5), [], 'honest empty, not an error');

  const down = createWebPort({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(down.search('x', 3), /web search unavailable/);
  await assert.rejects(down.search('   ', 3), /empty query/);

  seen.length = 0;
  const keyed = createWebPort({
    env: { BRAVE_API_KEY: 'b-key', TAVILY_API_KEY: 't-key' },
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      seen.push(u.split('?')[0]);
      if (u.startsWith('https://api.search.brave.com/')) {
        assert.equal((init?.headers as Record<string, string>)['X-Subscription-Token'], 'b-key');
        return new Response('rate limited', { status: 429 });
      }
      if (u.startsWith('https://api.tavily.com/')) {
        assert.equal(JSON.parse(String(init?.body)).api_key, 't-key');
        return Response.json({ results: [{ title: 'Tavily hit', url: 'https://t.example', content: 'from tavily' }] });
      }
      return new Response('x', { status: 500 });
    },
  });
  const r3 = await keyed.search('anything', 3);
  assert.deepEqual(seen.slice(0, 2), ['https://api.search.brave.com/res/v1/web/search', 'https://api.tavily.com/search']);
  assert.equal(r3[0].title, 'Tavily hit');
});
