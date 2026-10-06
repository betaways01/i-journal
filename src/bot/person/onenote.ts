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

export const DEFAULT_JOURNAL_NOTEBOOK = 'i-Journal';
export const DEFAULT_JOURNAL_SECTION = 'Daily Entries';

export interface OneNoteLibraryDeps {
  /** users.id for a Telegram user key, creating nothing. */
  userIdFor(userKey: string): number | null;
  auth: Pick<MicrosoftAuth, 'status' | 'accessToken'> & { markNeedsReconnect?(userId: number, reason: string): void };
  client: OneNoteClient;
  /** Saves the journal location in the connection's settings. */
  saveTarget(userId: number, notebook: string, section: string): void;
  onReconnectNeeded?(userKey: string, reason: string): void;
  log?: Logger;
}

export interface OneNoteLibrary extends LibraryPort {
  /** Drop caches after a (re)connect. */
  connected(userKey: string): void;
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
    const { sectionId } = await deps.client.ensureSection(userId, notebook, section);
    const existing = await deps.client.findInSection(userId, sectionId, title);
    if (existing) {
      await deps.client.updateText(userId, existing.id, title, xhtml);
      return existing;
    }
    return deps.client.createPage(userId, sectionId, title, xhtml);
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
      const pages = await deps.client.search(idOf(userKey), query, limit);
      return pages.map((p) => ({
        ref: 'remote:' + p.id,
        path: [p.notebook, p.section, p.title].filter(Boolean).join(' / '),
        snippet: '(open it with notes_read for the text)',
        date: p.lastModified?.slice(0, 10),
        url: p.url || undefined,
      }));
    },

    async read(userKey, ref) {
      const id = ref.replace(/^remote:/, '');
      if (!id) return null;
      try {
        const page = await deps.client.read(idOf(userKey), id);
        return { path: page.title || `OneNote page ${id}`, text: page.text || '(the page has no text)', url: page.url || undefined };
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
      if (userId != null) deps.client.forget(userId);
      errors.delete(userKey);
      warned.delete(userKey);
    },

    lastError: (userKey) => errors.get(userKey),
  };
}
