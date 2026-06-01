import { Telegraf } from 'telegraf';
import {
  finishRoutineRun,
  getDueRoutines,
  startRoutineRun,
  updateRoutine,
} from '../db/routines.repo';
import { getUserById } from '../db/users.repo';
import { getProfileForUser } from '../db/profile.repo';
import { sessionStore } from '../state/session.store';
import { computeNextRunAt, retryRunAt, isStaleTimeOfDaySlot } from '../routines/schedule';
import { runRoutineSkill } from '../routines/skills';
import { RoutineRecord } from '../routines/types';

const SWEEP_INTERVAL_MS = 60_000;
const ACTIVE_SESSION_POSTPONE_MINUTES = 15;
// A time-of-day routine (daily/weekly) that we only reach well after its slot — because the
// app was down/redeploying when it was due — must NOT be sent late. A "6pm reflection" should
// never arrive at 2am just because the process restarted overnight. Past this grace, we skip
// the missed slot and roll forward to the next real occurrence. Interval routines are cadence-
// based (not pinned to a time of day), so this staleness rule does not apply to them.
const STALE_GRACE_MS = 2 * 60 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;
const runningRoutineIds = new Set<number>();

/** True when a daily/weekly routine is so overdue that firing now would land at the wrong time of day. */
function isStaleTimeOfDayRun(routine: RoutineRecord, now: Date): boolean {
  return isStaleTimeOfDaySlot(routine.schedule, routine.next_run_at, now, STALE_GRACE_MS);
}

async function executeRoutine(bot: Telegraf, routine: RoutineRecord): Promise<void> {
  if (runningRoutineIds.has(routine.id)) return;
  runningRoutineIds.add(routine.id);

  const runId = startRoutineRun(routine);
  const now = new Date();

  try {
    const user = getUserById(routine.user_id);
    if (!user) {
      throw new Error('Routine user no longer exists.');
    }

    const profile = getProfileForUser(user.id);
    if (!profile) {
      throw new Error('Routine user has no profile.');
    }

    // Missed its time-of-day slot (app was down/redeploying through it) — don't fire it late at
    // the wrong hour. Roll forward to the next occurrence and record a clean skip.
    if (isStaleTimeOfDayRun(routine, now)) {
      const nextRunAt = computeNextRunAt(routine.schedule, now);
      updateRoutine(routine.id, { nextRunAt });
      finishRoutineRun({
        runId,
        status: 'postponed',
        outputSummary: `Missed slot (overdue) — skipped to ${nextRunAt.toISOString()}`,
      });
      console.log(`[RoutineSweeper] routine ${routine.id} missed its slot — skipped to ${nextRunAt.toISOString()}`);
      return;
    }

    if (sessionStore.has(user.telegram_id)) {
      const nextRunAt = retryRunAt(now, ACTIVE_SESSION_POSTPONE_MINUTES);
      updateRoutine(routine.id, { nextRunAt });
      finishRoutineRun({
        runId,
        status: 'postponed',
        outputSummary: `Active session running. Next try: ${nextRunAt.toISOString()}`,
      });
      return;
    }

    const result = await runRoutineSkill({ routine, profile });
    for (const message of result.messages) {
      // Defense-in-depth: never send empty text (Telegram 400s on it).
      if (message.trim()) await bot.telegram.sendMessage(user.telegram_id, message);
    }

    const mergedConfig = result.configUpdate ?? routine.config;
    updateRoutine(routine.id, {
      config: mergedConfig,
      lastRunAt: now,
      nextRunAt: computeNextRunAt(routine.schedule, now),
    });
    finishRoutineRun({
      runId,
      status: 'success',
      outputSummary: result.outputSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[RoutineSweeper] routine failed:', routine.id, message);
    updateRoutine(routine.id, { nextRunAt: retryRunAt(now) });
    finishRoutineRun({
      runId,
      status: 'failed',
      error: message,
    });
  } finally {
    runningRoutineIds.delete(routine.id);
  }
}

async function sweep(bot: Telegraf): Promise<void> {
  const due = getDueRoutines(new Date());
  for (const routine of due) {
    await executeRoutine(bot, routine);
  }
}

export function startRoutineSweeper(bot: Telegraf): void {
  if (intervalHandle) return;
  sweep(bot).catch((e) => console.error('[RoutineSweeper] boot sweep failed:', e));
  intervalHandle = setInterval(() => {
    sweep(bot).catch((e) => console.error('[RoutineSweeper] sweep failed:', e));
  }, SWEEP_INTERVAL_MS);
}

export function stopRoutineSweeper(): void {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  runningRoutineIds.clear();
}
