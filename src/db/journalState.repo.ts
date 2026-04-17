import { getDb } from './index';

export interface JournalState {
  lastMorningDate: string | null;
  lastEveningDate: string | null;
}

interface Row {
  user_id: number;
  last_morning_date: string | null;
  last_evening_date: string | null;
  updated_at: string;
}

export function getJournalStateForUser(userId: number): JournalState {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM journal_state WHERE user_id = ?')
    .get(userId) as Row | undefined;

  if (!row) return { lastMorningDate: null, lastEveningDate: null };
  return {
    lastMorningDate: row.last_morning_date,
    lastEveningDate: row.last_evening_date,
  };
}

export function updateJournalStateForUser(
  userId: number,
  updates: Partial<JournalState>
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const current = getJournalStateForUser(userId);

  const merged = { ...current, ...updates };

  db.prepare(
    `INSERT INTO journal_state (user_id, last_morning_date, last_evening_date, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       last_morning_date = excluded.last_morning_date,
       last_evening_date = excluded.last_evening_date,
       updated_at = excluded.updated_at`
  ).run(userId, merged.lastMorningDate, merged.lastEveningDate, now);
}
