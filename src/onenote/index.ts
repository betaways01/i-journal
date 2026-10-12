/**
 * A local index of each person's OneNote: every notebook, section group, section and page title, kept
 * in SQLite. Big accounts can't be listed in one request (Graph error 20266), so it is read a section at
 * a time in the background, and only sections that changed are re-read. Search, browsing and "what
 * did I write today" then answer instantly from the index; page text is still fetched live.
 */
import Database from 'better-sqlite3';
import { OneNoteClient, SectionRef } from './client';

export interface IndexedPage {
  id: string;
  title: string;
  sectionId: string;
  section: string;
  notebook: string;
  group?: string;
  created: string | null;
  modified: string | null;
  url: string | null;
}

export interface IndexStatus {
  sections: number;
  pages: number;
  refreshedAt?: string;
  building: boolean;
  done?: number;
  total?: number;
  error?: string;
}

interface Logger {
  info(m: string, f?: Record<string, unknown>): void;
  warn(m: string, f?: Record<string, unknown>): void;
}

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));
const o = (v: unknown) => (v == null ? null : String(v));

/** Notebook / Section group / Section / Title. */
export function pagePath(p: Pick<IndexedPage, 'notebook' | 'group' | 'section' | 'title'>): string {
  return [p.notebook, p.group, p.section, p.title].filter(Boolean).join(' / ');
}

function norm(x: string): string {
  return x.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface OneNoteIndex {
  /** Re-reads what changed (all of it with force). Runs once at a time per person. */
  refresh(userId: number, opts?: { force?: boolean }): Promise<void>;
  /** Starts a background refresh when the index is older than maxAgeMs (or empty). */
  ensureFresh(userId: number, maxAgeMs: number): void;
  status(userId: number): IndexStatus;
  search(userId: number, query: string, limit: number): IndexedPage[];
  notebooks(userId: number): Array<{ notebook: string; sections: number; pages: number; modified: string | null }>;
  sections(userId: number, notebook: string): Array<{ notebook: string; group?: string; section: string; pages: number; modified: string | null }>;
  pages(userId: number, notebook: string, section: string, limit: number): IndexedPage[];
  recent(userId: number, sinceIso: string, limit: number): IndexedPage[];
  page(userId: number, pageId: string): IndexedPage | null;
  /** Adds or updates one page the app itself wrote, so it is findable before the next refresh. */
  note(userId: number, page: Omit<IndexedPage, 'sectionId'> & { sectionId?: string }): void;
  clear(userId: number): void;
}

export function createOneNoteIndex(deps: { db: Database.Database; client: OneNoteClient; log?: Logger; now?: () => number; concurrency?: number }): OneNoteIndex {
  const { db, client } = deps;
  const now = deps.now ?? (() => Date.now());
  const concurrency = deps.concurrency ?? 3;
  db.exec(`
    CREATE TABLE IF NOT EXISTS onenote_sections (
      user_id INTEGER NOT NULL,
      section_id TEXT NOT NULL,
      notebook TEXT NOT NULL,
      grp TEXT,
      section TEXT NOT NULL,
      modified TEXT,
      read_modified TEXT,
      PRIMARY KEY (user_id, section_id)
    );
    CREATE TABLE IF NOT EXISTS onenote_pages (
      user_id INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created TEXT,
      modified TEXT,
      url TEXT,
      PRIMARY KEY (user_id, page_id)
    );
    CREATE INDEX IF NOT EXISTS onenote_pages_section ON onenote_pages(user_id, section_id);
    CREATE INDEX IF NOT EXISTS onenote_pages_modified ON onenote_pages(user_id, modified);
    CREATE TABLE IF NOT EXISTS onenote_index_state (
      user_id INTEGER PRIMARY KEY,
      refreshed_at TEXT,
      error TEXT
    );
  `);

  const running = new Map<number, Promise<void>>();
  const progress = new Map<number, { done: number; total: number }>();

  const pageFrom = (r: Row): IndexedPage => ({
    id: s(r.page_id),
    title: s(r.title),
    sectionId: s(r.section_id),
    section: s(r.section),
    notebook: s(r.notebook),
    group: r.grp ? s(r.grp) : undefined,
    created: o(r.created),
    modified: o(r.modified),
    url: o(r.url),
  });
  const JOIN = 'SELECT p.*, c.notebook, c.grp, c.section FROM onenote_pages p JOIN onenote_sections c ON c.user_id = p.user_id AND c.section_id = p.section_id';

  async function readSection(userId: number, sec: SectionRef): Promise<void> {
    const pages = await client.sectionPages(userId, sec.id);
    db.transaction(() => {
      db.prepare('DELETE FROM onenote_pages WHERE user_id = ? AND section_id = ?').run(userId, sec.id);
      const ins = db.prepare('INSERT OR REPLACE INTO onenote_pages (user_id, page_id, section_id, title, created, modified, url) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const p of pages) ins.run(userId, p.id, sec.id, p.title, p.created, p.modified, p.url);
      db.prepare('UPDATE onenote_sections SET read_modified = ? WHERE user_id = ? AND section_id = ?').run(sec.modified ?? new Date(now()).toISOString(), userId, sec.id);
    })();
  }

  async function run(userId: number, force: boolean): Promise<void> {
    const t0 = now();
    const sections = await client.listSections(userId);
    const known = new Map((db.prepare('SELECT section_id, read_modified FROM onenote_sections WHERE user_id = ?').all(userId) as Row[]).map((r) => [s(r.section_id), o(r.read_modified)]));
    db.transaction(() => {
      const keep = new Set(sections.map((x) => x.id));
      for (const id of known.keys()) {
        if (keep.has(id)) continue;
        db.prepare('DELETE FROM onenote_pages WHERE user_id = ? AND section_id = ?').run(userId, id);
        db.prepare('DELETE FROM onenote_sections WHERE user_id = ? AND section_id = ?').run(userId, id);
      }
      const up = db.prepare(
        `INSERT INTO onenote_sections (user_id, section_id, notebook, grp, section, modified) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, section_id) DO UPDATE SET notebook = excluded.notebook, grp = excluded.grp, section = excluded.section, modified = excluded.modified`
      );
      for (const x of sections) up.run(userId, x.id, x.notebook, x.group ?? null, x.name, x.modified);
    })();
    const todo = sections.filter((x) => force || !known.has(x.id) || known.get(x.id) == null || (x.modified ?? '') > (known.get(x.id) ?? ''));
    progress.set(userId, { done: 0, total: todo.length });
    let failures = 0;
    let firstError = '';
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const sec = todo[i++];
        try {
          await readSection(userId, sec);
        } catch (err) {
          failures++;
          firstError ||= err instanceof Error ? err.message : String(err);
          if ((err as { kind?: string }).kind === 'reconnect') throw err;
        }
        const p = progress.get(userId)!;
        p.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker));
    const error = failures ? `${failures} section(s) could not be read: ${firstError.slice(0, 160)}` : null;
    db.prepare('INSERT INTO onenote_index_state (user_id, refreshed_at, error) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET refreshed_at = excluded.refreshed_at, error = excluded.error').run(
      userId,
      new Date(now()).toISOString(),
      error
    );
    const st = statusOf(userId);
    deps.log?.info('onenote index refreshed', { userId, sections: st.sections, pages: st.pages, reread: todo.length, failures, ms: now() - t0 });
  }

  function statusOf(userId: number): IndexStatus {
    const sections = Number((db.prepare('SELECT COUNT(*) AS n FROM onenote_sections WHERE user_id = ?').get(userId) as Row).n);
    const pages = Number((db.prepare('SELECT COUNT(*) AS n FROM onenote_pages WHERE user_id = ?').get(userId) as Row).n);
    const st = db.prepare('SELECT refreshed_at, error FROM onenote_index_state WHERE user_id = ?').get(userId) as Row | undefined;
    const p = progress.get(userId);
    return {
      sections,
      pages,
      refreshedAt: st?.refreshed_at ? s(st.refreshed_at) : undefined,
      building: running.has(userId),
      ...(running.has(userId) && p ? { done: p.done, total: p.total } : {}),
      error: st?.error ? s(st.error) : undefined,
    };
  }

  const index: OneNoteIndex = {
    refresh(userId, opts = {}) {
      const existing = running.get(userId);
      if (existing) return existing;
      const p = run(userId, Boolean(opts.force))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          db.prepare('INSERT INTO onenote_index_state (user_id, refreshed_at, error) VALUES (?, NULL, ?) ON CONFLICT(user_id) DO UPDATE SET error = excluded.error').run(userId, message.slice(0, 300));
          deps.log?.warn('onenote index refresh failed', { userId, error: message.slice(0, 300) });
          throw err;
        })
        .finally(() => {
          running.delete(userId);
          progress.delete(userId);
        });
      running.set(userId, p);
      return p;
    },

    ensureFresh(userId, maxAgeMs) {
      if (running.has(userId)) return;
      const st = statusOf(userId);
      const age = st.refreshedAt ? now() - Date.parse(st.refreshedAt) : Infinity;
      if (age > maxAgeMs) void index.refresh(userId).catch(() => undefined);
    },

    status: statusOf,

    search(userId, query, limit) {
      // Numbers count ("Day 2", "Law 6"); other one-letter words don't.
      const words = norm(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 || /\d/.test(w));
      const rows = (db.prepare(`${JOIN} WHERE p.user_id = ?`).all(userId) as Row[]).map(pageFrom);
      if (!words.length) return rows.sort((a, b) => s(b.modified).localeCompare(s(a.modified))).slice(0, limit);
      const phrase = norm(query).trim();
      const scored: Array<{ p: IndexedPage; score: number }> = [];
      for (const p of rows) {
        const title = norm(p.title);
        const fields: Array<[string, Set<string>, number]> = [
          [title, 3],
          [norm(p.section), 2],
          [norm(p.group || ''), 1.5],
          [norm(p.notebook), 1],
        ].map(([f, wt]) => [f as string, new Set((f as string).split(/[^\p{L}\p{N}]+/u)), wt as number]);
        let score = 0;
        let matched = 0;
        for (const w of words) {
          let best = 0;
          // Short words and numbers match whole words only ("2" is not in "2026"); longer ones match inside words.
          for (const [f, set, wt] of fields) if (w.length >= 3 ? f.includes(w) : set.has(w)) best = Math.max(best, wt);
          if (best) matched++;
          score += best;
        }
        if (!matched) continue;
        if (title.includes(phrase)) score += 4;
        score += matched === words.length ? 5 : 0;
        scored.push({ p, score });
      }
      return scored.sort((a, b) => b.score - a.score || s(b.p.modified).localeCompare(s(a.p.modified))).slice(0, limit).map((x) => x.p);
    },

    notebooks(userId) {
      return (
        db
          .prepare(
            `SELECT c.notebook, COUNT(DISTINCT c.section_id) AS sections, COUNT(p.page_id) AS pages, MAX(COALESCE(p.modified, c.modified)) AS modified
             FROM onenote_sections c LEFT JOIN onenote_pages p ON p.user_id = c.user_id AND p.section_id = c.section_id
             WHERE c.user_id = ? GROUP BY c.notebook ORDER BY modified DESC`
          )
          .all(userId) as Row[]
      ).map((r) => ({ notebook: s(r.notebook), sections: Number(r.sections), pages: Number(r.pages), modified: o(r.modified) }));
    },

    sections(userId, notebook) {
      return (
        db
          .prepare(
            `SELECT c.notebook, c.grp, c.section, COUNT(p.page_id) AS pages, MAX(COALESCE(p.modified, c.modified)) AS modified
             FROM onenote_sections c LEFT JOIN onenote_pages p ON p.user_id = c.user_id AND p.section_id = c.section_id
             WHERE c.user_id = ? AND lower(c.notebook) = lower(?) GROUP BY c.section_id ORDER BY modified DESC`
          )
          .all(userId, notebook.trim()) as Row[]
      ).map((r) => ({ notebook: s(r.notebook), group: r.grp ? s(r.grp) : undefined, section: s(r.section), pages: Number(r.pages), modified: o(r.modified) }));
    },

    pages(userId, notebook, section, limit) {
      return (db.prepare(`${JOIN} WHERE p.user_id = ? AND lower(c.notebook) = lower(?) AND lower(c.section) = lower(?) ORDER BY p.modified DESC LIMIT ?`).all(userId, notebook.trim(), section.trim(), limit) as Row[]).map(
        pageFrom
      );
    },

    recent(userId, sinceIso, limit) {
      return (db.prepare(`${JOIN} WHERE p.user_id = ? AND p.modified >= ? ORDER BY p.modified DESC LIMIT ?`).all(userId, sinceIso, limit) as Row[]).map(pageFrom);
    },

    page(userId, pageId) {
      const r = db.prepare(`${JOIN} WHERE p.user_id = ? AND p.page_id = ?`).get(userId, pageId) as Row | undefined;
      return r ? pageFrom(r) : null;
    },

    note(userId, page) {
      if (!page.sectionId) return;
      db.prepare(
        `INSERT INTO onenote_sections (user_id, section_id, notebook, grp, section, modified) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, section_id) DO NOTHING`
      ).run(userId, page.sectionId, page.notebook, page.group ?? null, page.section, page.modified);
      db.prepare('INSERT OR REPLACE INTO onenote_pages (user_id, page_id, section_id, title, created, modified, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        userId,
        page.id,
        page.sectionId,
        page.title,
        page.created,
        page.modified,
        page.url
      );
    },

    clear(userId) {
      db.transaction(() => {
        db.prepare('DELETE FROM onenote_pages WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM onenote_sections WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM onenote_index_state WHERE user_id = ?').run(userId);
      })();
    },
  };
  return index;
}
