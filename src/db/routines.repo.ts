import { getDb } from './index';
import { RoutineKind, RoutineRecord, RoutineRunStatus, RoutineSchedule } from '../routines/types';

interface RoutineRow {
  id: number;
  user_id: number;
  kind: string;
  name: string;
  enabled: number;
  schedule_json: string;
  config_json: string | null;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRoutine(row: RoutineRow): RoutineRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind as RoutineKind,
    name: row.name,
    enabled: row.enabled,
    schedule: JSON.parse(row.schedule_json) as RoutineSchedule,
    config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : {},
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createRoutine(params: {
  userId: number;
  kind: RoutineKind;
  name: string;
  schedule: RoutineSchedule;
  config?: Record<string, unknown>;
  nextRunAt: Date;
}): RoutineRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO routines (
        user_id, kind, name, enabled, schedule_json, config_json, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      RETURNING *`
    )
    .get(
      params.userId,
      params.kind,
      params.name,
      JSON.stringify(params.schedule),
      params.config ? JSON.stringify(params.config) : null,
      params.nextRunAt.toISOString(),
      now,
      now
    ) as RoutineRow;

  return rowToRoutine(row);
}

export function findRoutineForUserByKind(userId: number, kind: RoutineKind): RoutineRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM routines WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId, kind) as RoutineRow | undefined;
  return row ? rowToRoutine(row) : null;
}

export function findRoutineForUserByKindAndName(
  userId: number,
  kind: RoutineKind,
  name: string
): RoutineRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM routines
       WHERE user_id = ? AND kind = ? AND lower(name) = lower(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(userId, kind, name) as RoutineRow | undefined;
  return row ? rowToRoutine(row) : null;
}

export function listRoutinesForUser(userId: number): RoutineRecord[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId)
    .map((row) => rowToRoutine(row as RoutineRow));
}

export function getDueRoutines(now: Date, limit = 50): RoutineRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM routines
       WHERE enabled = 1 AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`
    )
    .all(now.toISOString(), limit)
    .map((row) => rowToRoutine(row as RoutineRow));
}

export function updateRoutine(
  routineId: number,
  updates: {
    name?: string;
    enabled?: boolean;
    schedule?: RoutineSchedule;
    config?: Record<string, unknown>;
    nextRunAt?: Date;
    lastRunAt?: Date;
  }
): RoutineRecord | null {
  const db = getDb();
  const current = db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as RoutineRow | undefined;
  if (!current) return null;

  const next = {
    name: updates.name ?? current.name,
    enabled: updates.enabled === undefined ? current.enabled : updates.enabled ? 1 : 0,
    scheduleJson: updates.schedule ? JSON.stringify(updates.schedule) : current.schedule_json,
    configJson: updates.config ? JSON.stringify(updates.config) : current.config_json,
    nextRunAt: updates.nextRunAt ? updates.nextRunAt.toISOString() : current.next_run_at,
    lastRunAt: updates.lastRunAt ? updates.lastRunAt.toISOString() : current.last_run_at,
  };

  const row = db
    .prepare(
      `UPDATE routines SET
        name = ?,
        enabled = ?,
        schedule_json = ?,
        config_json = ?,
        next_run_at = ?,
        last_run_at = ?,
        updated_at = ?
       WHERE id = ?
       RETURNING *`
    )
    .get(
      next.name,
      next.enabled,
      next.scheduleJson,
      next.configJson,
      next.nextRunAt,
      next.lastRunAt,
      new Date().toISOString(),
      routineId
    ) as RoutineRow;

  return rowToRoutine(row);
}

export function startRoutineRun(routine: RoutineRecord): number {
  const db = getDb();
  const startedAt = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO routine_runs (routine_id, user_id, started_at, status)
       VALUES (?, ?, ?, 'running')
       RETURNING id`
    )
    .get(routine.id, routine.user_id, startedAt) as { id: number };
  return row.id;
}

export function finishRoutineRun(params: {
  runId: number;
  status: Exclude<RoutineRunStatus, 'running'>;
  outputSummary?: string;
  error?: string;
}): void {
  const db = getDb();
  db.prepare(
    `UPDATE routine_runs SET
      finished_at = ?,
      status = ?,
      output_summary = ?,
      error = ?
     WHERE id = ?`
  ).run(
    new Date().toISOString(),
    params.status,
    params.outputSummary ?? null,
    params.error ?? null,
    params.runId
  );
}
