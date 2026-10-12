/**
 * OneNote as each person's library and mirror. Connection state is local (tokens present and not
 * refused), so turns never wait on Microsoft; `status` adds a live check for /storage and /health.
 *
 * Journal days go to the person's journal notebook/section (default "i-Journal / Daily Entries"),
 * one page per day, updated in place through the page id the store remembers; photos follow the text.
 * Notes go to their own notebook/section. A refused sign-in is reported once through onReconnectNeeded.
 */
import { JournalDay, LibraryPort, Logger, Note, NoteHit, SyncResult } from '../../core/types';
import { MicrosoftAuth } from '../../onenote/oauth';
import { mediaKey, OneNoteClient, OneNoteError } from '../../onenote/client';
import { markdownToOneNote } from '../../onenote/xhtml';
import { IndexedPage, OneNoteIndex, pagePath } from '../../onenote/index';

export const DEFAULT_JOURNAL_NOTEBOOK = 'i-Journal';
export const DEFAULT_JOURNAL_SECTION = 'Daily Entries';

export interface OneNoteLibraryDeps {
  /** users.id for a Telegram user key, creating nothing. */
  userIdFor(userKey: string): number | null;
  auth: Pick<MicrosoftAuth, 'status' | 'accessToken'> & { markNeedsReconnect?(userId: number, reason: string): void };
  client: OneNoteClient;
  /** Local index of their notebooks, sections and page titles (search, browse, recent). */
  index: OneNoteIndex;
  /** Saves the journal location in the connection's settings. */
  saveTarget(userId: number, notebook: string, section: string): void;
  onReconnectNeeded?(userKey: string, reason: string): void;
  log?: Logger;
}

export interface OneNoteLibrary extends LibraryPort {
  /** Drop caches after a (re)connect and start reading the (maybe new) account. */
  connected(userKey: string): void;
  indexStatus(userKey: string): ReturnType<OneNoteIndex['status']> | null;
  /** Re-reads their notebooks now (only sections that changed). */
  refreshIndex(userKey: string): Promise<void>;
  lastError(userKey: string): string | undefined;
}

export function createOneNoteLibrary(deps: OneNoteLibraryDeps): OneNoteLibrary {
  const errors = new Map<string, string>();
  const warned = new Set<string>();

  const idOf = (userKey: string): number => {
    const id = deps.userIdFor(userKey);
    if (id == null) throw new OneNoteError('no account for this person yet', 'reconnect');
    return id;
  };

  /** Uses what is indexed now; refreshes in the background when older than 30 minutes. Throws only when nothing is usable yet. */
  function readyIndex(userId: number): void {
    deps.index.ensureFresh(userId, 30 * 60_000);
    const st = deps.index.status(userId);
    if (st.pages || st.sections || st.refreshedAt) return;
    if (st.building) throw new Error(`still reading their OneNote for the first time (${st.done ?? 0} of ${st.total ?? '?'} sections so far); ask again in a minute`);
    if (st.error) throw new Error(st.error);
  }

  const hit = (p: IndexedPage): NoteHit => ({
    ref: 'remote:' + p.id,
    path: pagePath(p),
    snippet: '(open it with notes_read for the text)',
    date: p.modified?.slice(0, 10),
    url: p.url || undefined,
  });
  const line = (p: IndexedPage) => `[remote:${p.id}] ${pagePath(p)}${p.modified ? ` (changed ${p.modified.slice(0, 10)})` : ''}`;

  const target = (userId: number) => {
    const meta = deps.auth.status(userId).meta;
    return {
      notebook: (typeof meta.notebook === 'string' && meta.notebook.trim()) || DEFAULT_JOURNAL_NOTEBOOK,
      section: (typeof meta.section === 'string' && meta.section.trim()) || DEFAULT_JOURNAL_SECTION,
    };
  };

  function failure(userKey: string, err: unknown): SyncResult {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 240);
    errors.set(userKey, message);
    if (err instanceof OneNoteError && (err.kind === 'reconnect' || err.kind === 'license')) {
      const userId = deps.userIdFor(userKey);
      if (userId != null && err.kind === 'reconnect' && deps.auth.status(userId).connected) deps.auth.markNeedsReconnect?.(userId, message);
      if (!warned.has(userKey)) {
        warned.add(userKey);
        deps.onReconnectNeeded?.(userKey, message);
      }
      return { ok: false, error: message, permanent: true };
    }
    return { ok: false, error: message };
  }

  /** Update the remembered page, else adopt a page with the same title, else create one. */
  async function upsert(userId: number, notebook: string, section: string, title: string, xhtml: string, knownPageId?: string): Promise<{ id: string; url: string | null }> {
    if (knownPageId) {
      try {
        await deps.client.updateText(userId, knownPageId, title, xhtml);
        const meta = await deps.client.page(userId, knownPageId);
        return { id: knownPageId, url: meta?.url ?? null };
      } catch (err) {
        if (!(err instanceof OneNoteError && err.kind === 'notfound')) throw err;
        deps.log?.info('onenote: remembered page is gone, writing a new one', { userId, title });
      }
    }
    const placed = await deps.client.ensureSection(userId, notebook, section);
    const existing = await deps.client.findInSection(userId, placed.sectionId, title);
    const page = existing ?? (await deps.client.createPage(userId, placed.sectionId, title, xhtml));
    if (existing) await deps.client.updateText(userId, existing.id, title, xhtml);
    // Findable at once, before the next index refresh.
    const at = new Date().toISOString();
    deps.index.note(userId, { id: page.id, title, sectionId: placed.sectionId, section: placed.section, notebook: placed.notebook, created: at, modified: at, url: page.url });
    return page;
  }

  return {
    isConnected(userKey) {
      const userId = deps.userIdFor(userKey);
      return userId != null && deps.auth.status(userId).connected;
    },

    async status(userKey) {
      const userId = deps.userIdFor(userKey);
      if (userId == null) return { connected: false, error: 'not connected' };
      const s = deps.auth.status(userId);
      if (!s.connected) return { connected: false, error: s.needsReconnect ? `needs signing in again — ${s.needsReconnect}` : 'not connected' };
      const label = [s.meta.displayName, s.meta.email].filter(Boolean).join(', ') || undefined;
      try {
        await deps.client.whoami(userId);
        errors.delete(userKey);
        return { connected: true, label };
      } catch (err) {
        const r = failure(userKey, err);
        return { connected: !r.permanent, label, error: r.error };
      }
    },

    async search(userKey, query, limit): Promise<NoteHit[]> {
      const userId = idOf(userKey);
      readyIndex(userId);
      return deps.index.search(userId, query, limit).map(hit);
    },

    async browse(userKey, opts) {
      const userId = idOf(userKey);
      readyIndex(userId);
      const st = deps.index.status(userId);
      const note = st.building ? `\n(Still reading your OneNote: ${st.done ?? 0} of ${st.total ?? '?'} changed sections so far, so this list may be incomplete.)` : '';
      const limit = Math.min(Math.max(opts.limit ?? 40, 1), 120);
      if (opts.recentDays) {
        const since = new Date(Date.now() - opts.recentDays * 86_400_000).toISOString();
        const pages = deps.index.recent(userId, since, limit);
        if (!pages.length) return { text: `No OneNote pages changed in the last ${opts.recentDays} day(s).${note}`, paths: [] };
        return { text: `OneNote pages changed in the last ${opts.recentDays} day(s), newest first:\n${pages.map(line).join('\n')}${note}`, paths: pages.map(pagePath) };
      }
      if (opts.notebook && opts.section) {
        const pages = deps.index.pages(userId, opts.notebook, opts.section, limit);
        if (!pages.length) return { text: `No pages found in ${opts.notebook} / ${opts.section} (check the names with notes_browse).${note}`, paths: [] };
        return { text: `${pages[0].notebook} / ${pages[0].section}, newest first:\n${pages.map(line).join('\n')}${note}`, paths: pages.map(pagePath) };
      }
      if (opts.notebook) {
        const secs = deps.index.sections(userId, opts.notebook);
        if (!secs.length) return { text: `No notebook called "${opts.notebook}" (call notes_browse with no arguments for the list).${note}`, paths: [] };
        const rows = secs.slice(0, limit).map((x) => `- ${[x.group, x.section].filter(Boolean).join(' / ')} — ${x.pages} page(s)${x.modified ? `, last changed ${x.modified.slice(0, 10)}` : ''}`);
        return { text: `Sections in ${secs[0].notebook} (most recently changed first):\n${rows.join('\n')}${secs.length > limit ? `\n…and ${secs.length - limit} more` : ''}${note}`, paths: [] };
      }
      const books = deps.index.notebooks(userId);
      if (!books.length) return { text: st.building ? `Reading your OneNote for the first time (${st.done ?? 0} of ${st.total ?? '?'} sections). Ask again in a minute.` : `No notebooks found in OneNote.${st.error ? ` (${st.error})` : ''}`, paths: [] };
      const total = books.reduce((n, b) => n + b.pages, 0);
      const rows = books.map((b) => `- ${b.notebook} — ${b.sections} section(s), ${b.pages} page(s)${b.modified ? `, last changed ${b.modified.slice(0, 10)}` : ''}`);
      return { text: `Their OneNote: ${books.length} notebook(s), ${total} page(s):\n${rows.join('\n')}${note}`, paths: [] };
    },

    async read(userKey, ref) {
      const id = ref.replace(/^remote:/, '');
      if (!id) return null;
      try {
        const userId = idOf(userKey);
        const page = await deps.client.read(userId, id);
        const known = deps.index.page(userId, id);
        return { path: known ? pagePath(known) : page.title || `OneNote page ${id}`, text: page.text || '(the page has no text)', url: page.url || undefined };
      } catch (err) {
        if (err instanceof OneNoteError && err.kind === 'notfound') return null;
        throw err;
      }
    },

    async syncDay(userKey, day: JournalDay, markdown): Promise<SyncResult> {
      try {
        const userId = idOf(userKey);
        const t = target(userId);
        const page = await upsert(userId, t.notebook, t.section, `${day.date} — ${day.weekday}`, markdownToOneNote(markdown), day.remotePageId);
        const photos = day.entries.flatMap((e) => e.media).filter((m) => m.kind === 'photo' && m.localPath).map((m) => ({ key: mediaKey(m), localPath: m.localPath!, mime: m.mime }));
        if (photos.length) {
          const added = await deps.client.syncPhotos(userId, page.id, photos);
          if (added) deps.log?.info('onenote: photos added', { userKey, date: day.date, added });
        }
        errors.delete(userKey);
        warned.delete(userKey);
        return { ok: true, remotePageId: page.id, remoteUrl: page.url || undefined };
      } catch (err) {
        return failure(userKey, err);
      }
    },

    async syncNote(userKey, note: Note): Promise<SyncResult> {
      try {
        const userId = idOf(userKey);
        const page = await upsert(userId, note.notebook, note.section || 'Notes', note.title, markdownToOneNote(note.body), note.remotePageId);
        errors.delete(userKey);
        warned.delete(userKey);
        return { ok: true, remotePageId: page.id, remoteUrl: page.url || undefined };
      } catch (err) {
        return failure(userKey, err);
      }
    },

    journalTarget(userKey) {
      const userId = deps.userIdFor(userKey);
      return userId == null ? { notebook: DEFAULT_JOURNAL_NOTEBOOK, section: DEFAULT_JOURNAL_SECTION } : target(userId);
    },

    async setJournalTarget(userKey, notebook, section) {
      const userId = idOf(userKey);
      const placed = await deps.client.ensureSection(userId, notebook, section);
      deps.saveTarget(userId, placed.notebook, placed.section);
      return { notebook: placed.notebook, section: placed.section };
    },

    connected(userKey) {
      const userId = deps.userIdFor(userKey);
      if (userId != null) {
        deps.client.forget(userId);
        // It may be a different Microsoft account: start the index over.
        deps.index.clear(userId);
        void deps.index.refresh(userId).catch(() => undefined);
      }
      errors.delete(userKey);
      warned.delete(userKey);
    },

    refreshIndex: (userKey) => deps.index.refresh(idOf(userKey)),

    indexStatus(userKey) {
      const userId = deps.userIdFor(userKey);
      return userId == null ? null : deps.index.status(userId);
    },

    lastError: (userKey) => errors.get(userKey),
  };
}
