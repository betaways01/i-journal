/**
 * OneNote over Microsoft Graph, per person. Every request goes through `call`: a fresh token, one
 * retry after a 401, backoff on 429/5xx (Retry-After honoured), timeouts, and errors classified so
 * callers can tell "connect again" from "try later" from "this page is gone".
 *
 * Pages this app writes keep their text in <div data-id="ij-text">, which can be replaced in place;
 * photos are appended one per request with data-id="ij-m-<key>", so each is uploaded once.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ReconnectNeeded } from './oauth';

const GRAPH = 'https://graph.microsoft.com/v1.0/me/onenote';

export type OneNoteErrorKind = 'reconnect' | 'license' | 'notfound' | 'throttled' | 'bad_request' | 'server' | 'network';

export class OneNoteError extends Error {
  constructor(
    message: string,
    public readonly kind: OneNoteErrorKind,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'OneNoteError';
  }
}

export interface PageRef {
  id: string;
  title: string;
  url: string | null;
  lastModified: string | null;
  section?: string;
  notebook?: string;
}

export interface PhotoFile {
  key: string;
  localPath: string;
  mime?: string;
}

interface Logger {
  info(m: string, f?: Record<string, unknown>): void;
  warn(m: string, f?: Record<string, unknown>): void;
}

export interface OneNoteClientDeps {
  token(userId: number, opts?: { forceRefresh?: boolean }): Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  now?: () => number;
}

interface PageLinks {
  oneNoteClientUrl?: { href?: string };
  oneNoteWebUrl?: { href?: string };
}

/** A tappable https link (Telegram ignores onenote: links; https still opens the app on phones). */
export function pageUrl(links?: PageLinks): string | null {
  const web = links?.oneNoteWebUrl?.href;
  if (web && /^https:\/\//i.test(web)) return web;
  const client = links?.oneNoteClientUrl?.href;
  const inner = client ? /^onenote:(https:\/\/.+)$/i.exec(client) : null;
  return inner ? inner[1] : null;
}

/** OneNote forbids some characters in notebook and section names. */
export function safeName(name: string, max: number): string {
  const cleaned = name.replace(/[?*\\/:<>|&#'"%~]/g, '-').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Notes').slice(0, max).trim();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mediaKey(m: { fileId?: string; localPath?: string }): string {
  return crypto.createHash('sha1').update(m.fileId || m.localPath || '').digest('hex').slice(0, 16);
}

function mimeOf(file: string, given?: string): string {
  if (given && given.startsWith('image/')) return given;
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

async function readError(res: Response): Promise<{ text: string; code?: string }> {
  const text = await res.text().catch(() => '');
  let code: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = j.error?.code;
    return { text: j.error?.message || text, code };
  } catch {
    return { text, code };
  }
}

function classify(status: number, body: string, code?: string): OneNoteErrorKind {
  if (/30121|SharePoint license|tenant does not have/i.test(body)) return 'license';
  if (status === 401 || status === 403) return 'reconnect';
  // 404, or 20102 "the requested resource does not exist": the page/section itself is gone. A PATCH
  // target that is missing is a 400 and stays bad_request.
  if (status === 404 || code === '20102') return 'notfound';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export interface OneNoteClient {
  whoami(userId: number): Promise<{ notebooks: number }>;
  ensureSection(userId: number, notebook: string, section: string): Promise<{ sectionId: string; notebook: string; section: string }>;
  createPage(userId: number, sectionId: string, title: string, textXhtml: string): Promise<{ id: string; url: string | null }>;
  /** Replaces the managed text block; adds it when the page has none (pages made elsewhere). */
  updateText(userId: number, pageId: string, title: string, textXhtml: string): Promise<void>;
  /** Uploads the photos the page does not show yet. Returns how many were added. */
  syncPhotos(userId: number, pageId: string, photos: PhotoFile[]): Promise<number>;
  page(userId: number, pageId: string): Promise<PageRef | null>;
  /** A page in this section with exactly this title (case-insensitive), newest first. */
  findInSection(userId: number, sectionId: string, title: string): Promise<{ id: string; url: string | null } | null>;
  search(userId: number, query: string, limit: number): Promise<PageRef[]>;
  read(userId: number, pageId: string): Promise<{ title: string; text: string; url: string | null }>;
  forget(userId: number): void;
}

const NB_MAX = 128;
const SECTION_MAX = 50;
const INDEX_TTL_MS = 15 * 60_000;
const IDS_TTL_MS = 30 * 60_000;

export function createOneNoteClient(deps: OneNoteClientDeps): OneNoteClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const sectionIds = new Map<string, { id: string; at: number }>();
  const indexes = new Map<number, { at: number; pages: PageRef[] }>();

  async function call(userId: number, url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<Response> {
    let forceRefresh = false;
    for (let attempt = 1; ; attempt++) {
      let token: string;
      try {
        token = await deps.token(userId, { forceRefresh });
      } catch (err) {
        if (err instanceof ReconnectNeeded) throw new OneNoteError(err.reason === 'not connected' ? 'OneNote is not connected' : err.reason, 'reconnect');
        throw new OneNoteError(err instanceof Error ? err.message : String(err), 'network');
      }
      let res: Response;
      try {
        res = await doFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt < 3) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new OneNoteError(`OneNote did not answer (${err instanceof Error ? err.message : String(err)})`, 'network');
      }
      if (res.ok) return res;
      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 1500 * 2 ** (attempt - 1);
        deps.log?.info('onenote: backing off', { status: res.status, waitMs: wait });
        await sleep(wait);
        continue;
      }
      const err = await readError(res);
      const kind = classify(res.status, err.text, err.code);
      const message =
        kind === 'license'
          ? "Microsoft won't open OneNote for this account (it reports no SharePoint/OneDrive license)."
          : kind === 'reconnect'
            ? 'Microsoft refused access to OneNote; connect it again.'
            : `OneNote said ${res.status}${err.code ? ` (${err.code})` : ''}: ${err.text.slice(0, 200)}`;
      throw new OneNoteError(message, kind, res.status, err.code);
    }
  }

  async function list<T>(userId: number, url: string, maxPages = 5): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = url;
    for (let i = 0; next && i < maxPages; i++) {
      const res = await call(userId, next);
      const data = (await res.json()) as { value?: T[]; '@odata.nextLink'?: string };
      out.push(...(data.value || []));
      next = data['@odata.nextLink'];
    }
    return out;
  }

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  async function ensureNotebook(userId: number, name: string): Promise<{ id: string; name: string }> {
    const books = await list<{ id: string; displayName: string }>(userId, `${GRAPH}/notebooks?$select=id,displayName&$top=100`);
    const found = books.find((b) => same(b.displayName, name));
    if (found) return { id: found.id, name: found.displayName };
    const res = await call(userId, `${GRAPH}/notebooks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) });
    const created = (await res.json()) as { id: string; displayName?: string };
    deps.log?.info('onenote: notebook created', { userId, notebook: name });
    return { id: created.id, name: created.displayName || name };
  }

  function contentHtml(title: string, textXhtml: string): string {
    return `<!DOCTYPE html><html><head><title>${escapeXml(title)}</title><meta name="created" content="${new Date(now()).toISOString()}" /></head><body><div data-id="ij-text">${textXhtml}</div></body></html>`;
  }

  async function patch(userId: number, pageId: string, commands: unknown[]): Promise<void> {
    await call(userId, `${GRAPH}/pages/${encodeURIComponent(pageId)}/content`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
  }

  async function page(userId: number, pageId: string): Promise<PageRef | null> {
    try {
      const res = await call(userId, `${GRAPH}/pages/${encodeURIComponent(pageId)}?$select=id,title,links,lastModifiedDateTime`);
      const p = (await res.json()) as { id: string; title?: string; links?: PageLinks; lastModifiedDateTime?: string };
      return { id: p.id, title: p.title || '', url: pageUrl(p.links), lastModified: p.lastModifiedDateTime || null };
    } catch (err) {
      if (err instanceof OneNoteError && err.kind === 'notfound') return null;
      throw err;
    }
  }

  async function rawContent(userId: number, pageId: string): Promise<string> {
    const res = await call(userId, `${GRAPH}/pages/${encodeURIComponent(pageId)}/content?includeIDs=true`);
    return res.text();
  }

  return {
    async whoami(userId) {
      const books = await list<{ id: string }>(userId, `${GRAPH}/notebooks?$select=id&$top=100`, 1);
      return { notebooks: books.length };
    },

    async ensureSection(userId, notebookName, sectionName) {
      const nb = safeName(notebookName, NB_MAX);
      const sec = safeName(sectionName || 'Notes', SECTION_MAX);
      const key = `${userId}\u0000${nb.toLowerCase()}\u0000${sec.toLowerCase()}`;
      const cached = sectionIds.get(key);
      if (cached && now() - cached.at < IDS_TTL_MS) return { sectionId: cached.id, notebook: nb, section: sec };
      const book = await ensureNotebook(userId, nb);
      const sections = await list<{ id: string; displayName: string }>(userId, `${GRAPH}/notebooks/${encodeURIComponent(book.id)}/sections?$select=id,displayName&$top=100`);
      let id = sections.find((s) => same(s.displayName, sec))?.id;
      if (!id) {
        const res = await call(userId, `${GRAPH}/notebooks/${encodeURIComponent(book.id)}/sections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: sec }),
        });
        id = ((await res.json()) as { id: string }).id;
        deps.log?.info('onenote: section created', { userId, notebook: book.name, section: sec });
      }
      sectionIds.set(key, { id, at: now() });
      return { sectionId: id, notebook: book.name, section: sec };
    },

    async createPage(userId, sectionId, title, textXhtml) {
      try {
        const res = await call(userId, `${GRAPH}/sections/${encodeURIComponent(sectionId)}/pages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/xhtml+xml' },
          body: contentHtml(title, textXhtml),
        });
        const page = (await res.json()) as { id: string; links?: PageLinks };
        indexes.delete(userId);
        return { id: page.id, url: pageUrl(page.links) };
      } catch (err) {
        if (err instanceof OneNoteError && err.kind === 'notfound') for (const k of sectionIds.keys()) if (k.startsWith(`${userId}\u0000`)) sectionIds.delete(k);
        throw err;
      }
    },

    async updateText(userId, pageId, title, textXhtml) {
      const block = `<div data-id="ij-text">${textXhtml}</div>`;
      try {
        await patch(userId, pageId, [
          { target: '#ij-text', action: 'replace', content: block },
          { target: 'title', action: 'replace', content: title },
        ]);
      } catch (err) {
        // A page written elsewhere has no managed block yet: add one at the end, then it is replaceable.
        if (err instanceof OneNoteError && err.kind === 'bad_request') {
          await patch(userId, pageId, [{ target: 'body', action: 'append', content: block }]);
          return;
        }
        throw err;
      }
    },

    async syncPhotos(userId, pageId, photos) {
      const usable = photos.filter((p) => p.localPath && fs.existsSync(p.localPath));
      if (!usable.length) return 0;
      const html = await rawContent(userId, pageId);
      let added = 0;
      for (const photo of usable) {
        const dataId = `ij-m-${photo.key}`;
        if (html.includes(`data-id="${dataId}"`)) continue;
        const bytes = fs.readFileSync(photo.localPath);
        const boundary = `ij${crypto.randomBytes(8).toString('hex')}`;
        const commands = JSON.stringify([{ target: 'body', action: 'append', content: `<p><img data-id="${dataId}" src="name:photo" alt="photo" width="480" /></p>` }]);
        const head = `--${boundary}\r\nContent-Disposition: form-data; name="Commands"\r\nContent-Type: application/json\r\n\r\n${commands}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"\r\nContent-Type: ${mimeOf(photo.localPath, photo.mime)}\r\n\r\n`;
        const body = Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
        await call(userId, `${GRAPH}/pages/${encodeURIComponent(pageId)}/content`, { method: 'PATCH', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body }, 60_000);
        added++;
      }
      return added;
    },

    page,

    async findInSection(userId, sectionId, title) {
      const pages = await list<{ id: string; title?: string; links?: PageLinks }>(
        userId,
        `${GRAPH}/sections/${encodeURIComponent(sectionId)}/pages?$select=id,title,links&$orderby=createdDateTime desc&$top=100`,
        5
      );
      const hit = pages.find((p) => same(p.title || '', title));
      return hit ? { id: hit.id, url: pageUrl(hit.links) } : null;
    },

    async search(userId, query, limit) {
      let idx = indexes.get(userId);
      if (!idx || now() - idx.at > INDEX_TTL_MS) {
        const raw = await list<{
          id: string;
          title?: string;
          links?: PageLinks;
          lastModifiedDateTime?: string;
          parentSection?: { displayName?: string };
          parentNotebook?: { displayName?: string };
        }>(
          userId,
          `${GRAPH}/pages?$select=id,title,links,lastModifiedDateTime&$expand=parentSection($select=displayName),parentNotebook($select=displayName)&$orderby=lastModifiedDateTime desc&$top=100`,
          5
        );
        idx = {
          at: now(),
          pages: raw.map((p) => ({
            id: p.id,
            title: p.title || '(untitled page)',
            url: pageUrl(p.links),
            lastModified: p.lastModifiedDateTime || null,
            section: p.parentSection?.displayName,
            notebook: p.parentNotebook?.displayName,
          })),
        };
        indexes.set(userId, idx);
      }
      const words = query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1);
      if (!words.length) return idx.pages.slice(0, limit);
      const scored = idx.pages
        .map((p, i) => {
          const hay = `${p.title} ${p.section || ''} ${p.notebook || ''}`.toLowerCase();
          const hits = words.filter((w) => hay.includes(w)).length;
          return { p, score: hits ? hits * 1000 - i : 0 };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((x) => x.p);
    },

    async read(userId, pageId) {
      const meta = await page(userId, pageId);
      if (!meta) throw new OneNoteError('That OneNote page no longer exists.', 'notfound', 404);
      const html = await rawContent(userId, pageId);
      return { title: meta.title, text: htmlToText(html), url: meta.url };
    },

    forget(userId) {
      indexes.delete(userId);
      for (const k of sectionIds.keys()) if (k.startsWith(`${userId}\u0000`)) sectionIds.delete(k);
    },
  };
}

/** Readable text from a OneNote page (tags dropped, block ends become line breaks). */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, ' [image] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 12_000 ? `${text.slice(0, 12_000).trimEnd()}\n…(truncated)` : text;
}
