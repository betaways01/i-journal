import crypto from 'crypto';
import {
  config,
  hasLegacyOwnerOneNoteConfigured,
  hasMicrosoftOAuthConfigured,
} from '../config';
import {
  getStorageConnectionForUser,
  StorageConnectionRecord,
  upsertStorageConnectionForUser,
} from '../db/storageConnections.repo';

const MICROSOFT_SCOPES = 'offline_access Notes.ReadWrite User.Read';
const STATE_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const AUTHORITY = `https://login.microsoftonline.com/${config.microsoft.tenantId}`;
const TOKEN_URL = `${AUTHORITY}/oauth2/v2.0/token`;
const PROFILE_URL =
  'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';

let legacyAccessToken = config.microsoft.accessToken;
let legacyRefreshToken = config.microsoft.refreshToken;

interface OAuthStatePayload {
  userId: number;
  issuedAt: number;
  nonce: string;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface MicrosoftProfile {
  id: string;
  displayName: string;
  email: string | null;
}

function getOAuthStateSecret(): string {
  return process.env.OAUTH_STATE_SECRET || config.telegram.botToken;
}

function signStatePayload(payload: string): string {
  return crypto
    .createHmac('sha256', getOAuthStateSecret())
    .update(payload)
    .digest('base64url');
}

function encodeState(payload: OAuthStatePayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  return `${encodedPayload}.${signStatePayload(encodedPayload)}`;
}

function decodeState(state: string): OAuthStatePayload {
  const [encodedPayload, signature] = state.split('.');

  if (!encodedPayload || !signature) {
    throw new Error('Invalid OAuth state.');
  }

  const expectedSignature = signStatePayload(encodedPayload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('OAuth state verification failed.');
  }

  const payload = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf-8')
  ) as OAuthStatePayload;

  if (!Number.isInteger(payload.userId) || typeof payload.issuedAt !== 'number') {
    throw new Error('OAuth state payload is malformed.');
  }

  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    throw new Error('OAuth session expired. Start the connection again from Telegram.');
  }

  return payload;
}

function getTokenExpiryIso(expiresInSeconds?: number): string | null {
  if (!expiresInSeconds) return null;
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function tokenNeedsRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) <= Date.now() + TOKEN_REFRESH_BUFFER_MS;
}

async function exchangeToken(params: URLSearchParams): Promise<MicrosoftTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = (await response.json()) as MicrosoftTokenResponse;
  if (!response.ok || data.error) {
    const detail = data.error_description || JSON.stringify(data);
    throw new Error(`Microsoft token exchange failed: ${detail}`);
  }

  return data;
}

async function fetchMicrosoftProfile(accessToken: string): Promise<MicrosoftProfile> {
  const response = await fetch(PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Microsoft profile: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    id: string;
    displayName?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
  };

  return {
    id: data.id,
    displayName: data.displayName || 'OneNote user',
    email: data.mail || data.userPrincipalName || null,
  };
}

function getStoredConnectionMetadata(
  connection: StorageConnectionRecord | null
): { profileName?: string; email?: string | null } {
  if (!connection?.metadata) return {};

  const profileName = typeof connection.metadata.displayName === 'string'
    ? connection.metadata.displayName
    : undefined;
  const email = typeof connection.metadata.email === 'string'
    ? connection.metadata.email
    : null;

  return { profileName, email };
}

export function buildMicrosoftAuthUrlForUser(userId: number): string {
  if (!hasMicrosoftOAuthConfigured()) {
    throw new Error('Microsoft OAuth is not configured on this server.');
  }

  const state = encodeState({
    userId,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(12).toString('hex'),
  });

  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: config.microsoft.redirectUri,
    scope: MICROSOFT_SCOPES,
    response_mode: 'query',
    state,
  });

  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

export function parseMicrosoftAuthState(state: string): number {
  return decodeState(state).userId;
}

export async function saveMicrosoftConnectionFromCode(
  userId: number,
  code: string
): Promise<MicrosoftProfile> {
  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    code,
    redirect_uri: config.microsoft.redirectUri,
    grant_type: 'authorization_code',
    scope: MICROSOFT_SCOPES,
  });

  const tokenData = await exchangeToken(params);
  if (!tokenData.access_token) {
    throw new Error('Microsoft did not return an access token.');
  }

  const profile = await fetchMicrosoftProfile(tokenData.access_token);

  upsertStorageConnectionForUser({
    userId,
    provider: 'onenote',
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? null,
    expiresAt: getTokenExpiryIso(tokenData.expires_in),
    metadata: {
      displayName: profile.displayName,
      email: profile.email,
      microsoftUserId: profile.id,
    },
  });

  return profile;
}

export async function refreshMicrosoftAccessTokenForUser(
  userId: number
): Promise<StorageConnectionRecord> {
  const connection = getStorageConnectionForUser(userId, 'onenote');
  if (!connection?.refresh_token) {
    throw new Error('No stored refresh token for this user.');
  }

  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    refresh_token: connection.refresh_token,
    grant_type: 'refresh_token',
    scope: MICROSOFT_SCOPES,
  });

  const tokenData = await exchangeToken(params);
  if (!tokenData.access_token) {
    throw new Error('Microsoft did not return an access token during refresh.');
  }

  return upsertStorageConnectionForUser({
    userId,
    provider: 'onenote',
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? connection.refresh_token,
    expiresAt: getTokenExpiryIso(tokenData.expires_in),
  });
}

export async function getValidMicrosoftAccessTokenForUser(userId: number): Promise<string> {
  const connection = getStorageConnectionForUser(userId, 'onenote');
  if (!connection) {
    throw new Error('No OneNote connection stored for this user.');
  }

  if (connection.access_token && !tokenNeedsRefresh(connection.expires_at)) {
    return connection.access_token;
  }

  const refreshed = await refreshMicrosoftAccessTokenForUser(userId);
  if (!refreshed.access_token) {
    throw new Error('No OneNote access token available after refresh.');
  }

  return refreshed.access_token;
}

export function getStoredMicrosoftConnectionSummary(userId: number): {
  connected: boolean;
  profileName?: string;
  email?: string | null;
} | null {
  const connection = getStorageConnectionForUser(userId, 'onenote');
  if (!connection) return null;

  return {
    connected: true,
    ...getStoredConnectionMetadata(connection),
  };
}

export async function refreshLegacyOwnerAccessToken(): Promise<string> {
  if (!legacyRefreshToken) {
    throw new Error(
      'No owner refresh token available. Reconnect through /storage or refresh the legacy server tokens.'
    );
  }

  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    refresh_token: legacyRefreshToken,
    grant_type: 'refresh_token',
    scope: MICROSOFT_SCOPES,
  });

  const tokenData = await exchangeToken(params);
  if (!tokenData.access_token) {
    throw new Error('Microsoft did not return a legacy owner access token.');
  }

  legacyAccessToken = tokenData.access_token;
  if (tokenData.refresh_token) {
    legacyRefreshToken = tokenData.refresh_token;
  }

  return legacyAccessToken;
}

export async function getValidLegacyOwnerAccessToken(): Promise<string> {
  if (!hasLegacyOwnerOneNoteConfigured()) {
    throw new Error('Legacy owner OneNote connection is not configured.');
  }

  if (legacyAccessToken) {
    return legacyAccessToken;
  }

  return refreshLegacyOwnerAccessToken();
}
