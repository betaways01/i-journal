/**
 * Microsoft sign-in for OneNote, per person.
 *
 * Two ways in, same result:
 * - Link (authorization code + PKCE): one tap, needs a redirect URI Microsoft can send the browser to.
 * - Device code: the person opens microsoft.com/devicelogin and types a short code. Needs no public
 *   address at all, so it works on a phone even when the server is localhost or has no domain.
 *
 * Azure app registrations differ (redirect registered as "Web" or as "Single-page application",
 * public client flows on or off). Instead of guessing, the token exchange tries the variants and
 * remembers which one this registration accepts, per connection. Tokens live in storage_connections;
 * the PKCE verifier and pending device codes live in onenote_pending so a restart mid-sign-in is fine.
 */
import crypto from 'crypto';
import Database from 'better-sqlite3';

export const SCOPES = 'offline_access Notes.ReadWrite User.Read';

export interface MicrosoftApp {
  clientId: string;
  clientSecret: string;
  /** 'common', 'consumers', 'organizations' or a tenant id. */
  tenant: string;
  /** Where Microsoft sends the browser back to (…/auth/callback). Empty disables the link flow. */
  redirectUri: string;
}

/** How this app registration wants tokens redeemed. Learned at connect time, reused on refresh. */
export type ClientMode = 'web' | 'spa' | 'spa+secret' | 'public' | 'public+secret';

export interface ConnectionMeta {
  displayName?: string;
  email?: string | null;
  microsoftUserId?: string;
  tenant?: string;
  mode?: ClientMode;
  via?: 'link' | 'device';
  connectedAt?: string;
  /** Set when Microsoft refused to renew the sign-in; the person has to connect again. */
  needsReconnect?: string;
  needsReconnectAt?: string;
  notebook?: string;
  section?: string;
  [key: string]: unknown;
}

export interface StoredConnection {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  meta: ConnectionMeta;
}

/** Where tokens are kept (storage_connections in the app, a Map in tests). */
export interface TokenStore {
  get(userId: number): StoredConnection | null;
  put(userId: number, conn: StoredConnection): void;
}

export interface ConnectedProfile {
  displayName: string;
  email: string | null;
}

export class ReconnectNeeded extends Error {
  constructor(public readonly reason: string) {
    super(`OneNote needs to be connected again: ${reason}`);
    this.name = 'ReconnectNeeded';
  }
}

type Fetch = typeof fetch;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const STATE_TTL_MS = 15 * 60_000;
const REFRESH_EARLY_MS = 2 * 60_000;

/** Errors after which the stored sign-in cannot be renewed and the person must connect again. */
function isDeadGrant(err: TokenResponse): boolean {
  const d = `${err.error || ''} ${err.error_description || ''}`;
  return (
    err.error === 'invalid_grant' ||
    err.error === 'interaction_required' ||
    /AADSTS(40008|50076|50078|50079|50173|65001|70000|70008|70043|700082|700084|500200)\b/.test(d)
  );
}

function describeDeadGrant(err: TokenResponse): string {
  const d = err.error_description || err.error || '';
  if (/AADSTS700084/.test(d)) return 'Microsoft ends this kind of sign-in after 24 hours (the redirect is registered as a single-page app in Azure)';
  if (/AADSTS40008/.test(d)) return 'Microsoft could not renew a personal account signed in through an organization (connect with the personal account directly)';
  if (/AADSTS(70000|70008|700082)/.test(d)) return 'the sign-in expired';
  if (/AADSTS(50076|50078|50079|50173|500200|65001)/.test(d) || err.error === 'interaction_required') return 'Microsoft wants you to sign in again';
  return d.split('\n')[0].slice(0, 160) || 'the sign-in can no longer be renewed';
}

function errorText(err: TokenResponse): string {
  return (err.error_description || err.error || 'unknown error').split('\n')[0].slice(0, 300);
}

export function isGuestAccount(upn: string | null | undefined): boolean {
  return Boolean(upn && upn.includes('#EXT#'));
}

export interface OAuthDeps {
  app: MicrosoftApp;
  db: Database.Database;
  tokens: TokenStore;
  fetchImpl?: Fetch;
  now?: () => number;
  log?: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void };
  /** Signs the state parameter. */
  stateSecret: string;
}

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  message: string;
}

export interface MicrosoftAuth {
  linkAvailable(): boolean;
  /** One-tap sign-in link (PKCE). */
  buildLink(userId: number): string;
  /** Finishes a link sign-in from the callback. Returns who signed in. */
  completeLink(state: string, code: string): Promise<{ userId: number; profile: ConnectedProfile }>;
  /** User id from a callback state, even if it is expired (for error messages). */
  userIdFromState(state: string): number | null;
  /** Starts a device-code sign-in. Poll with pollDevice until it settles. */
  startDevice(userId: number): Promise<DeviceLogin>;
  /** One poll; 'pending' until the person finishes. */
  pollDevice(userId: number): Promise<{ status: 'pending' | 'done' | 'expired' | 'declined' | 'none'; profile?: ConnectedProfile; error?: string }>;
  /** A valid access token, refreshing when needed. Throws ReconnectNeeded when renewal is impossible. */
  accessToken(userId: number, opts?: { forceRefresh?: boolean }): Promise<string>;
  status(userId: number): { connected: boolean; needsReconnect?: string; meta: ConnectionMeta };
  /** Microsoft refused access even with a fresh token: stop using this sign-in. */
  markNeedsReconnect(userId: number, reason: string): void;
  /** Keeps the journal location with the connection. */
  saveTarget(userId: number, notebook: string, section: string): void;
  disconnect(userId: number): void;
}

export function createMicrosoftAuth(deps: OAuthDeps): MicrosoftAuth {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const tenant = (deps.app.tenant || 'common').trim() || 'common';
  const authority = (t = tenant) => `https://login.microsoftonline.com/${encodeURIComponent(t)}`;

  deps.db.exec(`
    CREATE TABLE IF NOT EXISTS onenote_pending (
      nonce TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      secret TEXT NOT NULL,
      interval_sec INTEGER NOT NULL DEFAULT 5,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const prune = () => deps.db.prepare('DELETE FROM onenote_pending WHERE expires_at < ?').run(now());

  const sign = (payload: string) => crypto.createHmac('sha256', deps.stateSecret).update(payload).digest('base64url');

  function encodeState(userId: number, nonce: string): string {
    const payload = Buffer.from(JSON.stringify({ u: userId, t: now(), n: nonce })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function decodeState(state: string, allowExpired = false): { userId: number; nonce: string } {
    const [payload, signature] = state.split('.');
    if (!payload || !signature) throw new Error('That sign-in link is not valid. Ask for a new one.');
    const a = Buffer.from(signature);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('That sign-in link is not valid. Ask for a new one.');
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: number; t: number; n: string };
    if (!Number.isInteger(p.u) || typeof p.t !== 'number' || typeof p.n !== 'string') throw new Error('That sign-in link is not valid. Ask for a new one.');
    if (!allowExpired && now() - p.t > STATE_TTL_MS) throw new Error('That sign-in link expired (they last 15 minutes). Ask for a new one.');
    return { userId: p.u, nonce: p.n };
  }

  async function post(url: string, body: URLSearchParams, origin?: string): Promise<TokenResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (origin) headers.Origin = origin;
    const res = await doFetch(url, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(20_000) });
    let data: TokenResponse;
    try {
      data = (await res.json()) as TokenResponse;
    } catch {
      data = { error: `http_${res.status}`, error_description: `Microsoft answered ${res.status} without JSON` };
    }
    if (!res.ok && !data.error) data.error = `http_${res.status}`;
    return data;
  }

  const redirectOrigin = () => {
    try {
      return new URL(deps.app.redirectUri).origin;
    } catch {
      return undefined;
    }
  };

  /** Parameters for one redemption variant. */
  function variant(mode: ClientMode, base: Record<string, string>): { body: URLSearchParams; origin?: string } {
    const withSecret = mode === 'web' || mode === 'spa+secret' || mode === 'public+secret';
    const body = new URLSearchParams({ client_id: deps.app.clientId, scope: SCOPES, ...base });
    if (withSecret && deps.app.clientSecret) body.set('client_secret', deps.app.clientSecret);
    return { body, origin: mode === 'spa' || mode === 'spa+secret' ? redirectOrigin() : undefined };
  }

  /**
   * Redeems with the first mode Microsoft accepts. AADSTS9002327: redirect is a single-page app (needs
   * an Origin, no secret). AADSTS700025: public client must not send a secret. AADSTS7000218: a secret
   * is required. Anything else is a real answer.
   */
  async function redeem(url: string, base: Record<string, string>, modes: ClientMode[]): Promise<{ data: TokenResponse; mode: ClientMode }> {
    let last: { data: TokenResponse; mode: ClientMode } | null = null;
    for (const mode of modes) {
      const v = variant(mode, base);
      const data = await post(url, v.body, v.origin);
      last = { data, mode };
      if (data.access_token) return last;
      const d = data.error_description || '';
      const wrongShape = /AADSTS(9002327|9002326|700025|7000218|9002325)\b/.test(d);
      if (!wrongShape) return last;
      deps.log?.info('microsoft token: trying another client mode', { tried: mode, code: (/AADSTS\d+/.exec(d) || [''])[0] });
    }
    return last!;
  }

  async function profileOf(accessToken: string): Promise<{ id: string; displayName: string; email: string | null; upn: string | null }> {
    const res = await doFetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Signed in, but Microsoft would not say who you are (${res.status}).`);
    const d = (await res.json()) as { id: string; displayName?: string; mail?: string | null; userPrincipalName?: string | null };
    return { id: d.id, displayName: d.displayName || 'Microsoft account', email: d.mail || d.userPrincipalName || null, upn: d.userPrincipalName || null };
  }

  /** OneNote must answer for this account before it counts as connected. */
  async function probeOneNote(accessToken: string): Promise<void> {
    const res = await doFetch('https://graph.microsoft.com/v1.0/me/onenote/notebooks?$top=1&$select=id', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return;
    const body = await res.text();
    if (/30121|SharePoint license|tenant does not have/i.test(body)) {
      throw new Error(
        "Signed in, but Microsoft won't open OneNote for this account (it reports no SharePoint/OneDrive license). " +
          'Try the Microsoft account whose OneNote you actually use; if it is a personal account, sign in with it directly, not through a work tenant.'
      );
    }
    throw new Error(`Signed in, but OneNote did not answer for this account (${res.status}). ${body.slice(0, 160)}`);
  }

  async function finish(userId: number, data: TokenResponse, mode: ClientMode, via: 'link' | 'device'): Promise<ConnectedProfile> {
    const token = data.access_token!;
    const p = await profileOf(token);
    if (isGuestAccount(p.upn)) {
      throw new Error(
        'You signed in as a guest of an organization, and OneNote does not work that way. ' +
          (tenant === 'common' || tenant === 'consumers' ? 'Sign in with your own account instead.' : 'The server is set to one organization (MICROSOFT_TENANT_ID); set it to common so personal accounts sign in directly.')
      );
    }
    await probeOneNote(token);
    const prev = deps.tokens.get(userId);
    const meta: ConnectionMeta = {
      ...(prev?.meta.notebook ? { notebook: prev.meta.notebook } : {}),
      ...(prev?.meta.section ? { section: prev.meta.section } : {}),
      displayName: p.displayName,
      email: p.email,
      microsoftUserId: p.id,
      tenant,
      mode,
      via,
      connectedAt: new Date(now()).toISOString(),
    };
    deps.tokens.put(userId, {
      accessToken: token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_in ? new Date(now() + data.expires_in * 1000).toISOString() : null,
      meta,
    });
    deps.log?.info('onenote connected', { userId, via, mode, spaLimited: mode.startsWith('spa') });
    if (mode.startsWith('spa')) {
      deps.log?.warn(
        'onenote: the redirect URI is registered as a single-page app in Azure, so Microsoft ends this sign-in after 24 hours. Register it under "Web" to stay connected.'
      );
    }
    return { displayName: p.displayName, email: p.email };
  }

  const linkModes: ClientMode[] = ['web', 'spa', 'spa+secret'];
  const deviceModes: ClientMode[] = ['public', 'public+secret'];

  const refreshing = new Map<number, Promise<string>>();

  async function refresh(userId: number): Promise<string> {
    const conn = deps.tokens.get(userId);
    if (!conn) throw new ReconnectNeeded('not connected');
    if (conn.meta.needsReconnect) throw new ReconnectNeeded(conn.meta.needsReconnect);
    if (!conn.refreshToken) throw markDead(userId, conn, 'there is no saved sign-in to renew');
    const known = conn.meta.mode;
    const order: ClientMode[] = known ? [known, ...[...linkModes, ...deviceModes].filter((m) => m !== known)] : [...linkModes, ...deviceModes];
    const { data, mode } = await redeem(`${authority(conn.meta.tenant || tenant)}/oauth2/v2.0/token`, { grant_type: 'refresh_token', refresh_token: conn.refreshToken }, order);
    if (!data.access_token) {
      if (isDeadGrant(data)) throw markDead(userId, conn, describeDeadGrant(data));
      throw new Error(`Microsoft would not renew the OneNote sign-in right now: ${errorText(data)}`);
    }
    deps.tokens.put(userId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? conn.refreshToken,
      expiresAt: data.expires_in ? new Date(now() + data.expires_in * 1000).toISOString() : null,
      meta: { ...conn.meta, mode },
    });
    return data.access_token;
  }

  function markDead(userId: number, conn: StoredConnection, reason: string): ReconnectNeeded {
    deps.tokens.put(userId, { ...conn, accessToken: null, meta: { ...conn.meta, needsReconnect: reason, needsReconnectAt: new Date(now()).toISOString() } });
    deps.log?.warn('onenote sign-in can no longer be renewed', { userId, reason });
    return new ReconnectNeeded(reason);
  }

  return {
    linkAvailable: () => Boolean(deps.app.clientId && deps.app.redirectUri),

    buildLink(userId) {
      prune();
      const nonce = crypto.randomBytes(16).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      deps.db
        .prepare('INSERT INTO onenote_pending (nonce, user_id, kind, secret, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(nonce, userId, 'link', verifier, now(), now() + STATE_TTL_MS);
      const params = new URLSearchParams({
        client_id: deps.app.clientId,
        response_type: 'code',
        redirect_uri: deps.app.redirectUri,
        scope: SCOPES,
        response_mode: 'query',
        state: encodeState(userId, nonce),
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${authority()}/oauth2/v2.0/authorize?${params.toString()}`;
    },

    userIdFromState(state) {
      try {
        return decodeState(state, true).userId;
      } catch {
        return null;
      }
    },

    async completeLink(state, code) {
      const { userId, nonce } = decodeState(state);
      const row = deps.db.prepare("SELECT secret FROM onenote_pending WHERE nonce = ? AND kind = 'link'").get(nonce) as { secret: string } | undefined;
      deps.db.prepare('DELETE FROM onenote_pending WHERE nonce = ?').run(nonce);
      if (!row) throw new Error('That sign-in link was already used or has expired. Ask for a new one.');
      const { data, mode } = await redeem(
        `${authority()}/oauth2/v2.0/token`,
        { grant_type: 'authorization_code', code, redirect_uri: deps.app.redirectUri, code_verifier: row.secret },
        linkModes
      );
      if (!data.access_token) throw new Error(`Microsoft sign-in failed: ${errorText(data)}`);
      return { userId, profile: await finish(userId, data, mode, 'link') };
    },

    async startDevice(userId) {
      prune();
      const body = new URLSearchParams({ client_id: deps.app.clientId, scope: SCOPES });
      const res = await doFetch(`${authority()}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      const d = (await res.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; message?: string } & TokenResponse;
      if (!d.device_code || !d.user_code) {
        const text = errorText(d);
        if (/AADSTS70002/.test(text)) {
          throw new Error('Sign-in with a code is switched off for this app in Azure (Authentication → "Allow public client flows" → Yes).');
        }
        throw new Error(`Microsoft would not start a sign-in: ${text}`);
      }
      deps.db.prepare("DELETE FROM onenote_pending WHERE user_id = ? AND kind = 'device'").run(userId);
      deps.db
        .prepare('INSERT INTO onenote_pending (nonce, user_id, kind, secret, interval_sec, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`device:${userId}:${now()}`, userId, 'device', d.device_code, Math.max(2, d.interval || 5), now(), now() + (d.expires_in || 900) * 1000);
      return {
        userCode: d.user_code,
        verificationUri: d.verification_uri || 'https://microsoft.com/devicelogin',
        expiresInSec: d.expires_in || 900,
        message: d.message || '',
      };
    },

    async pollDevice(userId) {
      const row = deps.db.prepare("SELECT nonce, secret, expires_at FROM onenote_pending WHERE user_id = ? AND kind = 'device' ORDER BY created_at DESC").get(userId) as
        | { nonce: string; secret: string; expires_at: number }
        | undefined;
      if (!row) return { status: 'none' };
      if (row.expires_at < now()) {
        deps.db.prepare('DELETE FROM onenote_pending WHERE nonce = ?').run(row.nonce);
        return { status: 'expired' };
      }
      const { data, mode } = await redeem(`${authority()}/oauth2/v2.0/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: row.secret }, deviceModes);
      if (data.access_token) {
        deps.db.prepare('DELETE FROM onenote_pending WHERE nonce = ?').run(row.nonce);
        try {
          return { status: 'done', profile: await finish(userId, data, mode, 'device') };
        } catch (err) {
          return { status: 'declined', error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (data.error === 'authorization_pending' || data.error === 'slow_down') return { status: 'pending' };
      deps.db.prepare('DELETE FROM onenote_pending WHERE nonce = ?').run(row.nonce);
      if (data.error === 'expired_token' || data.error === 'code_expired') return { status: 'expired' };
      return { status: 'declined', error: data.error === 'authorization_declined' ? 'You cancelled the sign-in.' : errorText(data) };
    },

    async accessToken(userId, opts = {}) {
      const conn = deps.tokens.get(userId);
      if (!conn || (!conn.accessToken && !conn.refreshToken)) throw new ReconnectNeeded('not connected');
      if (conn.meta.needsReconnect) throw new ReconnectNeeded(conn.meta.needsReconnect);
      const fresh = conn.accessToken && conn.expiresAt && Date.parse(conn.expiresAt) - REFRESH_EARLY_MS > now();
      if (fresh && !opts.forceRefresh) return conn.accessToken!;
      const running = refreshing.get(userId);
      if (running) return running;
      const p = refresh(userId).finally(() => refreshing.delete(userId));
      refreshing.set(userId, p);
      return p;
    },

    status(userId) {
      const conn = deps.tokens.get(userId);
      const meta = conn?.meta ?? {};
      if (!conn || (!conn.accessToken && !conn.refreshToken)) return { connected: false, meta };
      if (meta.needsReconnect) return { connected: false, needsReconnect: meta.needsReconnect, meta };
      return { connected: true, meta };
    },

    markNeedsReconnect(userId, reason) {
      const conn = deps.tokens.get(userId);
      if (conn && !conn.meta.needsReconnect) markDead(userId, conn, reason);
    },

    saveTarget(userId, notebook, section) {
      const conn = deps.tokens.get(userId) ?? { accessToken: null, refreshToken: null, expiresAt: null, meta: {} };
      deps.tokens.put(userId, { ...conn, meta: { ...conn.meta, notebook, section } });
    },

    disconnect(userId) {
      const conn = deps.tokens.get(userId);
      if (!conn) return;
      deps.tokens.put(userId, { accessToken: null, refreshToken: null, expiresAt: null, meta: { notebook: conn.meta.notebook, section: conn.meta.section } });
    },
  };
}
