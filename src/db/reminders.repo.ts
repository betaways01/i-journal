import { getDb } from './index';

export type ReminderKind =
  | 'evening_remind_later'
  | 'morning_remind_later'
  | 'agent.custom_reminder';

export interface PendingReminder {
  id: number;
  user_id: number;
  kind: ReminderKind;
  fire_at: string;
  payload_json: string | null;
  created_at: string;
}

export function scheduleReminder(params: {
  userId: number;
  kind: ReminderKind;
  fireAt: Date;
  payload?: Record<string, unknown>;
  replaceExisting?: boolean;
}): number {
  const db = getDb();
  const now = new Date().toISOString();

  const replaceExisting = params.replaceExisting ?? params.kind !== 'agent.custom_reminder';
  if (replaceExisting) {
    db.prepare('DELETE FROM pending_reminders WHERE user_id = ? AND kind = ?').run(
      params.userId,
      params.kind
    );
  }

  const result = db
    .prepare(
      `INSERT INTO pending_reminders (user_id, kind, fire_at, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      params.userId,
      params.kind,
      params.fireAt.toISOString(),
      params.payload ? JSON.stringify(params.payload) : null,
      now
    ) as { id: number };

  return result.id;
}

export function getDueReminders(now: Date): PendingReminder[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM pending_reminders WHERE fire_at <= ? ORDER BY fire_at ASC LIMIT 50`
    )
    .all(now.toISOString()) as PendingReminder[];
}

export function listRemindersForUser(userId: number): PendingReminder[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM pending_reminders WHERE user_id = ? ORDER BY fire_at ASC')
    .all(userId) as PendingReminder[];
}

export function getReminderById(reminderId: number): PendingReminder | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pending_reminders WHERE id = ?').get(reminderId) as
    | PendingReminder
    | undefined;
  return row ?? null;
}

export function deleteReminder(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM pending_reminders WHERE id = ?').run(id);
}

export function clearRemindersForUser(userId: number, kind?: ReminderKind): void {
  const db = getDb();
  if (kind) {
    db.prepare('DELETE FROM pending_reminders WHERE user_id = ? AND kind = ?').run(userId, kind);
  } else {
    db.prepare('DELETE FROM pending_reminders WHERE user_id = ?').run(userId);
  }
}
