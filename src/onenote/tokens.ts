/** OneNote tokens per person in storage_connections (provider 'onenote'). */
import Database from 'better-sqlite3';
import { ConnectionMeta, StoredConnection, TokenStore } from './oauth';

interface Row {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  metadata_json: string | null;
}

export function sqliteTokenStore(db: Database.Database): TokenStore {
  return {
    get(userId) {
      const row = db.prepare("SELECT access_token, refresh_token, expires_at, metadata_json FROM storage_connections WHERE user_id = ? AND provider = 'onenote'").get(userId) as Row | undefined;
      if (!row) return null;
      let meta: ConnectionMeta = {};
      try {
        meta = row.metadata_json ? (JSON.parse(row.metadata_json) as ConnectionMeta) : {};
      } catch {
        meta = {};
      }
      return { accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.expires_at, meta };
    },
    put(userId, conn: StoredConnection) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO storage_connections (user_id, provider, access_token, refresh_token, expires_at, metadata_json, created_at, updated_at)
         VALUES (?, 'onenote', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`
      ).run(userId, conn.accessToken, conn.refreshToken, conn.expiresAt, JSON.stringify(conn.meta || {}), now, now);
    },
  };
}
