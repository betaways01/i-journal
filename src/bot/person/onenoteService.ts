/**
 * Everything OneNote for the bot: sign-in (link or code), the per-person library, and telling the
 * person what happened in the chat (through `notify`, which also puts the message in the transcript
 * so the companion knows). Nothing here blocks a turn on Microsoft.
 */
import Database from 'better-sqlite3';
import { ConnectOffer, Logger } from '../../core/types';
import { createOneNoteClient } from '../../onenote/client';
import { createMicrosoftAuth, MicrosoftApp, MicrosoftAuth } from '../../onenote/oauth';
import { sqliteTokenStore } from '../../onenote/tokens';
import { createOneNoteLibrary, OneNoteLibrary } from './onenote';

export interface OneNoteServiceDeps {
  db: Database.Database;
  /** Null when MICROSOFT_CLIENT_ID is not set: OneNote is then simply unavailable. */
  app: MicrosoftApp | null;
  /** The redirect URI was set explicitly to an https address (so it is registered in Azure): use the one-tap link. */
  preferLink?: boolean;
  stateSecret: string;
  log: Logger;
  /** Sends a message to the person and records it in their conversation. */
  notify(userKey: string, markdown: string): Promise<void>;
  /** Called after a successful (re)connect, e.g. to clear sync backoff. */
  onConnected?(userKey: string): void;
  fetchImpl?: typeof fetch;
  /** How often to ask Microsoft whether a code sign-in finished (default 5s). */
  devicePollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface OneNoteService {
  configured: boolean;
  auth: MicrosoftAuth | null;
  library: OneNoteLibrary | undefined;
  offer(userKey: string): Promise<ConnectOffer>;
  /** For the web callback. Returns what to show on the page. */
  completeLink(state: string, code: string): Promise<{ ok: boolean; title: string; message: string }>;
  linkFailed(state: string, description: string): Promise<{ title: string; message: string }>;
  /** Picks up device sign-ins that were waiting when the process restarted. */
  resumePending(): void;
  /** Live check of every saved connection; a dead sign-in is marked and its person told once. */
  checkAll(): Promise<Array<{ userKey: string; connected: boolean; error?: string }>>;
  storageLines(userKey: string): Promise<string[]>;
  stop(): void;
}

export function createOneNoteService(deps: OneNoteServiceDeps): OneNoteService {
  const { db, log } = deps;
  const userIdFor = (userKey: string): number | null => {
    const row = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(userKey) as { id: number } | undefined;
    return row ? row.id : null;
  };
  const userKeyFor = (userId: number): string | null => {
    const row = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId) as { telegram_id: string } | undefined;
    return row ? row.telegram_id : null;
  };

  if (!deps.app || !deps.app.clientId) {
    return {
      configured: false,
      auth: null,
      library: undefined,
      offer: async () => ({ error: 'Microsoft sign-in is not configured on this server (MICROSOFT_CLIENT_ID).' }),
      completeLink: async () => ({ ok: false, title: 'Not configured', message: 'OneNote is not set up on this server.' }),
      linkFailed: async () => ({ title: 'Not configured', message: 'OneNote is not set up on this server.' }),
      resumePending: () => undefined,
      checkAll: async () => [],
      storageLines: async () => ['• OneNote: not set up on this server. Everything is kept safely here.'],
      stop: () => undefined,
    };
  }

  const app = deps.app;
  const auth = createMicrosoftAuth({ app, db, tokens: sqliteTokenStore(db), stateSecret: deps.stateSecret, log, fetchImpl: deps.fetchImpl, now: deps.now });
  const client = createOneNoteClient({ token: (id, o) => auth.accessToken(id, o), log, fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep });
  const pollMs = deps.devicePollMs ?? 5000;
  const library = createOneNoteLibrary({
    userIdFor,
    auth,
    client,
    saveTarget: (id, nb, sec) => auth.saveTarget(id, nb, sec),
    log,
    onReconnectNeeded: (userKey, reason) => {
      void deps
        .notify(userKey, `⚠️ OneNote stopped taking copies: ${reason}\nEverything is still saved here. Say *connect OneNote* when you want to sign in again.`)
        .catch((err) => log.warn('onenote: could not send the reconnect notice', { userKey, error: String(err) }));
    },
  });

  const httpsRedirect = Boolean(deps.preferLink) && /^https:\/\//i.test(app.redirectUri);
  const localRedirect = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(app.redirectUri);
  const polls = new Map<string, NodeJS.Timeout>();

  async function connected(userKey: string, who: { displayName: string; email: string | null }, via: string): Promise<void> {
    library.connected(userKey);
    deps.onConnected?.(userKey);
    log.info('onenote: person connected', { userKey, via });
    const target = library.journalTarget?.(userKey);
    await deps
      .notify(
        userKey,
        `✅ OneNote connected (${[who.displayName, who.email].filter(Boolean).join(', ')}).\nJournal pages will be copied to *${target?.notebook} / ${target?.section}* within a few minutes; notes go to their own notebooks.`
      )
      .catch((err) => log.warn('onenote: could not send the connected notice', { userKey, error: String(err) }));
  }

  function poll(userKey: string, userId: number, everyMs: number): void {
    const existing = polls.get(userKey);
    if (existing) clearTimeout(existing);
    const step = async () => {
      polls.delete(userKey);
      let r;
      try {
        r = await auth.pollDevice(userId);
      } catch (err) {
        log.warn('onenote: device poll failed; trying again', { userKey, error: err instanceof Error ? err.message : String(err) });
        polls.set(userKey, setTimeout(step, everyMs * 2));
        return;
      }
      if (r.status === 'pending') {
        polls.set(userKey, setTimeout(step, everyMs));
        return;
      }
      if (r.status === 'done' && r.profile) return connected(userKey, r.profile, 'device');
      if (r.status === 'expired') {
        log.info('onenote: device code expired', { userKey });
        await deps.notify(userKey, 'The OneNote sign-in code expired before it was used. Say *connect OneNote* for a new one.').catch(() => undefined);
        return;
      }
      if (r.status === 'declined') {
        log.warn('onenote: device sign-in failed', { userKey, error: r.error });
        await deps.notify(userKey, `OneNote was not connected: ${r.error}`).catch(() => undefined);
      }
    };
    const t = setTimeout(step, everyMs);
    t.unref?.();
    polls.set(userKey, t);
  }

  return {
    configured: true,
    auth,
    library,

    async offer(userKey) {
      const userId = userIdFor(userKey);
      if (userId == null) return { error: 'I could not find your account yet. Send me any message first.' };
      if (httpsRedirect) return { url: auth.buildLink(userId) };
      try {
        const d = await auth.startDevice(userId);
        poll(userKey, userId, pollMs);
        log.info('onenote: device sign-in started', { userKey });
        return { url: d.verificationUri, code: d.userCode, expiresInMin: Math.max(1, Math.round(d.expiresInSec / 60)) };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        log.warn('onenote: code sign-in unavailable, falling back to the link', { userKey, error: why });
        if (!auth.linkAvailable()) return { error: why };
        return localRedirect
          ? { url: auth.buildLink(userId), note: 'this link only works on the computer the bot is running on (the server has no public web address yet).' }
          : { url: auth.buildLink(userId) };
      }
    },

    async completeLink(state, code) {
      try {
        const { userId, profile } = await auth.completeLink(state, code);
        const userKey = userKeyFor(userId);
        if (userKey) await connected(userKey, profile, 'link');
        return { ok: true, title: 'OneNote connected', message: 'You can go back to Telegram now.' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('onenote: link sign-in failed', { error: message });
        const userId = auth.userIdFromState(state);
        const userKey = userId != null ? userKeyFor(userId) : null;
        if (userKey) await deps.notify(userKey, `OneNote was not connected: ${message}`).catch(() => undefined);
        return { ok: false, title: 'OneNote was not connected', message };
      }
    },

    async linkFailed(state, description) {
      const message = /AADSTS50020/.test(description)
        ? 'Microsoft refused this account because the Azure app does not accept personal accounts. In Azure set "Supported account types" to include personal Microsoft accounts.'
        : `Microsoft sign-in did not finish: ${description.split('\n')[0].slice(0, 300)}`;
      log.warn('onenote: microsoft returned an error to the callback', { error: description.slice(0, 300) });
      const userId = auth.userIdFromState(state);
      const userKey = userId != null ? userKeyFor(userId) : null;
      if (userKey) await deps.notify(userKey, `OneNote was not connected. ${message}`).catch(() => undefined);
      return { title: 'OneNote was not connected', message };
    },

    resumePending() {
      const rows = db.prepare("SELECT user_id FROM onenote_pending WHERE kind = 'device' AND expires_at > ?").all((deps.now ?? Date.now)()) as Array<{ user_id: number }>;
      for (const r of rows) {
        const userKey = userKeyFor(r.user_id);
        if (userKey) poll(userKey, r.user_id, pollMs);
      }
      if (rows.length) log.info('onenote: resumed waiting sign-ins', { count: rows.length });
    },

    async checkAll() {
      const rows = db
        .prepare(
          "SELECT u.telegram_id AS k FROM storage_connections s JOIN users u ON u.id = s.user_id WHERE s.provider = 'onenote' AND (s.access_token IS NOT NULL OR s.refresh_token IS NOT NULL)"
        )
        .all() as Array<{ k: string }>;
      const out: Array<{ userKey: string; connected: boolean; error?: string }> = [];
      for (const { k } of rows) {
        const s = await library.status(k).catch((err) => ({ connected: false, error: err instanceof Error ? err.message : String(err) }));
        out.push({ userKey: k, connected: s.connected, error: s.error });
        log.info('onenote: connection checked', { userKey: k, connected: s.connected, error: s.error });
      }
      return out;
    },

    async storageLines(userKey) {
      const lines = ['• Everything is saved here first (journal, notes, reminders, memory).'];
      const s = await library.status(userKey);
      const target = library.journalTarget?.(userKey);
      if (s.connected) {
        lines.push(`• OneNote: connected${s.label ? ` (${s.label})` : ''}. Journal pages go to *${target?.notebook} / ${target?.section}*.`);
        if (s.error) lines.push(`• Last OneNote problem: ${s.error}`);
      } else {
        lines.push(`• OneNote: ${s.error && s.error !== 'not connected' ? s.error : 'not connected'}. Say *connect OneNote* to sign in.`);
      }
      const last = library.lastError(userKey);
      if (last && s.connected && last !== s.error) lines.push(`• Last copy problem: ${last}`);
      return lines;
    },

    stop() {
      for (const t of polls.values()) clearTimeout(t);
      polls.clear();
    },
  };
}
