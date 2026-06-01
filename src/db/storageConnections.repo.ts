import { getDb } from './index';

export type StorageProvider = 'onenote';

export interface StorageConnectionRecord {
  id: number;
  user_id: number;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

interface Row {
  id: number;
  user_id: number;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: Row): StorageConnectionRecord {
  let metadata: Record<string, unknown> | null = null;

  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch (error) {
      console.error('[Storage] Failed to parse metadata_json:', error);
    }
  }

  return {
    ...row,
    metadata,
  };
}

export function getStorageConnectionForUser(
  userId: number,
  provider: StorageProvider
): StorageConnectionRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM storage_connections WHERE user_id = ? AND provider = ?')
    .get(userId, provider) as Row | undefined;

  return row ? rowToRecord(row) : null;
}

export function upsertStorageConnectionForUser(params: {
  userId: number;
  provider: StorageProvider;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}): StorageConnectionRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getStorageConnectionForUser(params.userId, params.provider);

  const accessToken = params.accessToken ?? existing?.access_token ?? null;
  const refreshToken = params.refreshToken ?? existing?.refresh_token ?? null;
  const expiresAt = params.expiresAt ?? existing?.expires_at ?? null;
  const metadata = params.metadata ?? existing?.metadata ?? null;

  const row = db
    .prepare(
      `INSERT INTO storage_connections (
        user_id, provider, access_token, refresh_token, expires_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
      RETURNING *`
    )
    .get(
      params.userId,
      params.provider,
      accessToken,
      refreshToken,
      expiresAt,
      metadata ? JSON.stringify(metadata) : null,
      existing?.created_at ?? now,
      now
    ) as Row;

  return rowToRecord(row);
}

/**
 * Merge a patch into the connection's metadata (preserving tokens and existing metadata keys).
 * Returns null if the user has no stored connection for this provider.
 */
export function mergeStorageMetadataForUser(
  userId: number,
  provider: StorageProvider,
  patch: Record<string, unknown>
): StorageConnectionRecord | null {
  const existing = getStorageConnectionForUser(userId, provider);
  if (!existing) return null;
  const metadata = { ...(existing.metadata ?? {}), ...patch };
  return upsertStorageConnectionForUser({ userId, provider, metadata });
}

export function deleteStorageConnectionForUser(
  userId: number,
  provider: StorageProvider
): void {
  const db = getDb();
  db.prepare('DELETE FROM storage_connections WHERE user_id = ? AND provider = ?').run(userId, provider);
}

export function hasStorageConnectionForUser(
  userId: number,
  provider: StorageProvider
): boolean {
  return getStorageConnectionForUser(userId, provider) !== null;
}
