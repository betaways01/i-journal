import { getDb } from './index';

export interface UserRow {
  id: number;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  is_owner: number;
  onboarding_complete: number;
  created_at: string;
  updated_at: string;
}

export function upsertUser(params: {
  telegramId: string;
  username?: string;
  firstName?: string;
  isOwner?: boolean;
}): UserRow {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .get(params.telegramId) as UserRow | undefined;

  if (existing) {
    const updated = db
      .prepare(
        `UPDATE users
         SET username = COALESCE(?, username),
             first_name = COALESCE(?, first_name),
             updated_at = ?
         WHERE telegram_id = ?
         RETURNING *`
      )
      .get(params.username ?? null, params.firstName ?? null, now, params.telegramId) as UserRow;
    return updated;
  }

  const inserted = db
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, is_owner, onboarding_complete, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       RETURNING *`
    )
    .get(
      params.telegramId,
      params.username ?? null,
      params.firstName ?? null,
      params.isOwner ? 1 : 0,
      now,
      now
    ) as UserRow;
  return inserted;
}

export function getUserByTelegramId(telegramId: string): UserRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as
    | UserRow
    | undefined;
  return row ?? null;
}

export function getUserById(id: number): UserRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ?? null;
}

export function markOnboardingComplete(userId: number): void {
  const db = getDb();
  db.prepare('UPDATE users SET onboarding_complete = 1, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    userId
  );
}

export function listOnboardedUsers(): UserRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE onboarding_complete = 1').all() as UserRow[];
}
