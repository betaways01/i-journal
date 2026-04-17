import { getDb } from './index';
import { ConversationState } from '../types';

interface Row {
  user_id: number;
  session_type: string;
  started_at: string;
  target_date: string | null;
  state_json: string;
  updated_at: string;
}

function rowToState(row: Row): ConversationState {
  const parsed = JSON.parse(row.state_json);
  return {
    ...parsed,
    startedAt: new Date(row.started_at),
  } as ConversationState;
}

export function getSessionForUser(userId: number): ConversationState | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId) as Row | undefined;
  return row ? rowToState(row) : null;
}

export function setSessionForUser(
  userId: number,
  state: ConversationState,
  targetDate?: string
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const serializable = { ...state, startedAt: state.startedAt.toISOString() };

  db.prepare(
    `INSERT INTO sessions (user_id, session_type, started_at, target_date, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       session_type = excluded.session_type,
       started_at = excluded.started_at,
       target_date = excluded.target_date,
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    state.sessionType,
    state.startedAt.toISOString(),
    targetDate ?? null,
    JSON.stringify(serializable),
    now
  );
}

export function clearSessionForUser(userId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function hasSessionForUser(userId: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(userId);
  return row !== undefined;
}

export function clearStaleSessions(maxAgeHours: number, timezone: string): number {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sessions').all() as Row[];
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

  let cleared = 0;
  for (const row of rows) {
    const startedMs = new Date(row.started_at).getTime();
    const sessionDate = new Date(row.started_at).toLocaleDateString('en-CA', { timeZone: timezone });
    if (startedMs < cutoff || sessionDate !== today) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      cleared++;
    }
  }
  return cleared;
}
