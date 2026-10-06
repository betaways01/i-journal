/**
 * Background sweeper: delivers due reminders, runs scheduled tasks, and sends at most one gentle
 * "journal still open" nudge per evening. Transport-agnostic: the caller supplies `deliver`.
 *
 * Delivery is at-least-once: an occurrence is marked done only after `deliver` resolved. A failed
 * delivery is retried with backoff; a permanent failure (bot blocked) cancels the reminder.
 */
import { Core } from './index';
import { tidyMemory } from './maintenance';
import { renderDay } from './tools/util';
import { formatLocal, isValidTimezone, localParts, nextOccurrence } from './time';
import { Logger, Reminder } from './types';

export interface SweeperDeps {
  core: Core;
  /** Sends Markdown to the user. Throw an error with `permanent: true` when retrying cannot help. */
  deliver(userKey: string, markdown: string): Promise<void>;
  /** Runs a job in the user's turn queue so it never races a conversation turn. */
  enqueue(userKey: string, job: () => Promise<void>): Promise<void>;
  /** Which users this process can reach (e.g. numeric Telegram ids, or 'cli'). */
  canDeliver(userKey: string): boolean;
  defaultTimezone?: string;
  now?: () => Date;
  log?: Logger;
  /** Local hour after which an open journal with entries may get one nudge. */
  nudgeHour?: number;
  /** How long they must have been quiet before a nudge. */
  nudgeIdleMs?: number;
  maxAttempts?: number;
  /** Run the memory tidy once a night (between 03:00 and 06:00 local). */
  tidy?: boolean;
  /** Copy changed journal days and notes to the remote library (OneNote) when connected. */
  sync?: boolean;
}

export interface SweepReport {
  delivered: number;
  deferred: number;
  cancelled: number;
  nudged: number;
  silent: number;
}

const LATE_MS = 10 * 60_000;

export function retryDelayMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts));
}

function isPermanent(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { permanent?: boolean }).permanent);
}

export function createSweeper(deps: SweeperDeps) {
  const store = deps.core.deps.store;
  const now = deps.now ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? 8;
  const nudgeHour = deps.nudgeHour ?? 21;
  const nudgeIdleMs = deps.nudgeIdleMs ?? 30 * 60_000;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const tzFor = (userKey: string): string => {
    const fallback = deps.defaultTimezone || deps.core.deps.config?.defaultTimezone || 'UTC';
    const tz = store.getProfile(userKey).timezone || fallback;
    return isValidTimezone(tz) ? tz : isValidTimezone(fallback) ? fallback : 'UTC';
  };

  async function fail(r: Reminder, err: unknown, at: Date, next: Date | null, report: SweepReport): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    if (isPermanent(err)) {
      store.cancelReminder(r.userKey, r.id);
      report.cancelled++;
      deps.log?.warn('reminder cancelled: delivery is impossible', { id: r.id, error: msg });
      return;
    }
    if (r.attempts + 1 >= maxAttempts) {
      store.completeOccurrence(r.id, at, next);
      report.cancelled++;
      deps.log?.error('reminder given up after repeated failures', { id: r.id, error: msg });
      return;
    }
    store.deferOccurrence(r.id, new Date(at.getTime() + retryDelayMs(r.attempts)));
    report.deferred++;
    deps.log?.warn('reminder delivery failed; will retry', { id: r.id, attempts: r.attempts + 1, error: msg });
  }

  async function fire(id: number, userKey: string, report: SweepReport): Promise<void> {
    const r = store.getReminder(userKey, id);
    const at = now();
    if (!r || r.status !== 'pending' || new Date(r.retryAt || r.fireAt).getTime() > at.getTime()) return;
    const tz = tzFor(userKey);
    const scheduled = new Date(r.fireAt);
    const late = at.getTime() - scheduled.getTime() > LATE_MS ? ` (this was due ${formatLocal(scheduled, tz)} — sorry it's late)` : '';
    const next = r.recurrence ? nextOccurrence(r.recurrence, scheduled, at, tz) : null;

    if (r.kind === 'notify') {
      const text = `⏰ ${r.text}${late ? `\n_${late.trim()}_` : ''}`;
      try {
        await deps.deliver(userKey, text);
      } catch (err) {
        await fail(r, err, at, next, report);
        return;
      }
      store.appendMessages(userKey, [{ role: 'assistant', content: text, at: at.toISOString(), origin: 'delivered' }]);
      store.completeOccurrence(r.id, at, next);
      report.delivered++;
      return;
    }

    const result = await deps.core.runTurn({
      userKey,
      inbound: { kind: 'scheduled', text: r.text + late, media: [] },
      now: at,
      timezone: tz,
    });
    if (result.degraded) {
      await fail(r, new Error('model unavailable for scheduled task'), at, next, report);
      return;
    }
    if (result.silent) {
      store.completeOccurrence(r.id, at, next);
      report.silent++;
      return;
    }
    try {
      await deps.deliver(userKey, result.reply);
    } catch (err) {
      await fail(r, err, at, next, report);
      return;
    }
    store.completeOccurrence(r.id, at, next);
    report.delivered++;
  }

  async function nudge(userKey: string, report: SweepReport): Promise<void> {
    const at = now();
    const tz = tzFor(userKey);
    const lp = localParts(at, tz);
    const st = store.getState(userKey);
    if (!st.journalOpen || st.nudgedOn === lp.date || lp.hour < nudgeHour) return;
    const date = st.journalDate || lp.date;
    const day = store.getDay(userKey, date);
    if (!day || !day.entries.length) return;
    if (st.lastSeenAt && at.getTime() - new Date(st.lastSeenAt).getTime() < nudgeIdleMs) return;
    st.nudgedOn = lp.date;
    store.saveState(userKey, st);
    const opened = st.journalOpenedAt ? formatLocal(new Date(st.journalOpenedAt), tz) : 'earlier';
    const result = await deps.core.runTurn({
      userKey,
      inbound: {
        kind: 'nudge',
        text: `The journal for ${day.weekday} ${date} has been open since ${opened} with ${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'}, and they have gone quiet. It is now ${lp.time}.`,
        media: [],
      },
      now: at,
      timezone: tz,
    });
    if (result.silent || !result.reply.trim()) {
      report.silent++;
      return;
    }
    try {
      await deps.deliver(userKey, result.reply);
      report.nudged++;
    } catch (err) {
      deps.log?.warn('nudge delivery failed', { userKey, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function maybeTidy(userKey: string): Promise<void> {
    const at = now();
    const lp = localParts(at, tzFor(userKey));
    const st = store.getState(userKey);
    if (lp.hour < 3 || lp.hour >= 6 || st.tidiedOn === lp.date) return;
    st.tidiedOn = lp.date;
    store.saveState(userKey, st);
    const r = await tidyMemory(deps.core.deps, userKey, at);
    if (r && (r.removed || r.merged)) deps.log?.info('memory tidied', { userKey, ...r });
  }

  const syncRest = new Map<string, { until: number; failures: number }>();

  /** 1, 2, 4 … 30 minutes after consecutive failures; reset by a success. */
  function rest(userKey: string, what: string, error: string | undefined, permanent: boolean | undefined): void {
    const failures = (syncRest.get(userKey)?.failures ?? 0) + 1;
    const ms = Math.min(30, 2 ** (failures - 1)) * 60_000;
    syncRest.set(userKey, { until: now().getTime() + ms, failures });
    deps.log?.[permanent ? 'error' : 'warn']('onenote copy failed', { userKey, what, error, permanent: Boolean(permanent), retryInMin: ms / 60_000, failures });
  }

  /** Mirrors up to a few changed items per tick. */
  async function sync(userKey: string): Promise<void> {
    const lib = deps.core.deps.ports.library;
    if (!lib || !lib.isConnected(userKey) || (syncRest.get(userKey)?.until ?? 0) > now().getTime()) return;
    let budget = 3;
    for (const day of store.dirtyDays(userKey)) {
      if (budget-- <= 0) return;
      const started = Date.now();
      const r = await lib.syncDay(userKey, day, renderDay(day));
      if (!r.ok) return rest(userKey, `day ${day.date}`, r.error, r.permanent);
      syncRest.delete(userKey);
      store.markDaySynced(userKey, day.date, { at: now(), rev: day.rev, remotePageId: r.remotePageId, remoteUrl: r.remoteUrl });
      deps.log?.info('onenote copied day', { userKey, date: day.date, ms: Date.now() - started });
    }
    for (const note of store.dirtyNotes(userKey)) {
      if (budget-- <= 0) return;
      const started = Date.now();
      const r = await lib.syncNote(userKey, note);
      if (!r.ok) return rest(userKey, `note ${note.id}`, r.error, r.permanent);
      syncRest.delete(userKey);
      store.markNoteSynced(userKey, note.id, { at: now(), rev: note.rev, remotePageId: r.remotePageId, remoteUrl: r.remoteUrl });
      deps.log?.info('onenote copied note', { userKey, note: note.id, ms: Date.now() - started });
    }
  }

  async function tick(): Promise<SweepReport> {
    const report: SweepReport = { delivered: 0, deferred: 0, cancelled: 0, nudged: 0, silent: 0 };
    if (running) return report;
    running = true;
    try {
      for (const r of store.dueReminders(now(), 50)) {
        if (!deps.canDeliver(r.userKey)) continue;
        await deps.enqueue(r.userKey, () => fire(r.id, r.userKey, report)).catch((err) =>
          deps.log?.error('reminder job failed', { id: r.id, error: err instanceof Error ? err.message : String(err) })
        );
      }
      for (const userKey of store.listUserKeys()) {
        if (!deps.canDeliver(userKey)) continue;
        await deps.enqueue(userKey, () => nudge(userKey, report)).catch((err) =>
          deps.log?.error('nudge job failed', { userKey, error: err instanceof Error ? err.message : String(err) })
        );
        if (deps.sync) {
          await deps.enqueue(userKey, () => sync(userKey)).catch((err) =>
            deps.log?.error('OneNote sync failed', { userKey, error: err instanceof Error ? err.message : String(err) })
          );
        }
        if (deps.tidy) {
          await deps.enqueue(userKey, () => maybeTidy(userKey)).catch((err) =>
            deps.log?.error('memory tidy failed', { userKey, error: err instanceof Error ? err.message : String(err) })
          );
        }
      }
    } finally {
      running = false;
    }
    return report;
  }

  return {
    tick,
    /** Clears the OneNote backoff for a person (after they connect again). */
    resetSync(userKey: string): void {
      syncRest.delete(userKey);
    },
    start(intervalMs = 15_000): void {
      if (timer) return;
      const loop = () => {
        tick()
          .catch((err) => deps.log?.error('sweep failed', { error: err instanceof Error ? err.message : String(err) }))
          .finally(() => {
            if (timer !== undefined) {
              timer = setTimeout(loop, intervalMs);
              timer.unref?.();
            }
          });
      };
      timer = setTimeout(loop, 0);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
