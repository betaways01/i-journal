import { getDb } from './index';
import { ConversationState, SessionType } from '../types';

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

const SESSION_TTL_HOURS: Record<SessionType, number> = {
  morning: 24,
  evening: 24,
  drop: 24,
  vent: 24,
  settings: 72,
  automation_setup: 72,
  routine_setup: 72,
  onboarding: 168,
};

function ttlHoursForSessionType(sessionType: string): number {
  return SESSION_TTL_HOURS[sessionType as SessionType] ?? 24;
}

function rowIsStale(row: Row, now = new Date()): boolean {
  const startedMs = new Date(row.started_at).getTime();
  if (!Number.isFinite(startedMs)) return true;
  const ttlMs = ttlHoursForSessionType(row.session_type) * 60 * 60 * 1000;
  return now.getTime() - startedMs > ttlMs;
}

export function isSessionStale(state: ConversationState, now = new Date()): boolean {
  const startedMs = state.startedAt.getTime();
  if (!Number.isFinite(startedMs)) return true;
  const ttlMs = ttlHoursForSessionType(state.sessionType) * 60 * 60 * 1000;
  return now.getTime() - startedMs > ttlMs;
}

export function getSessionForUser(userId: number): ConversationState | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId) as Row | undefined;
  if (!row) return null;
  if (rowIsStale(row)) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return null;
  }
  return rowToState(row);
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
  const row = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId) as Row | undefined;
  if (!row) return false;
  if (rowIsStale(row)) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return false;
  }
  return true;
}

export function clearStaleSessions(): number {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sessions').all() as Row[];
  const now = new Date();

  let cleared = 0;
  for (const row of rows) {
    if (rowIsStale(row, now)) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      cleared++;
    }
  }
  return cleared;
}
