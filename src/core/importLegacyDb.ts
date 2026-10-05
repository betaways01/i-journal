/**
 * One-time import of what the original companion kept in SQLite (users, profiles, journal_entries,
 * agent_workspace_docs, routines, pending_reminders) into the core store, so switching a running
 * deployment over loses nothing. Read-only on the old tables; each person is imported at most once.
 */
import Database from 'better-sqlite3';
import { isIsoDate, isValidTimezone, localParts, shiftDate, zonedToUtc } from './time';
import { Logger, Recurrence, Store } from './types';

export interface LegacyDbReport {
  userKey: string;
  skipped?: string;
  profile: boolean;
  facts: number;
  entries: number;
  days: number;
  reminders: number;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseJson<T>(raw: unknown): T | null {
  try {
    return typeof raw === 'string' && raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** "Label: value" from the old markdown docs; placeholders count as empty. */
function docField(doc: string, label: string): string {
  const line = doc.split('\n').find((l) => l.trim().toLowerCase().startsWith(label.toLowerCase() + ':'));
  const value = line ? line.slice(line.indexOf(':') + 1).trim() : '';
  return /^(unknown|none( yet)?|n\/a|-)?$/i.test(value) ? '' : value;
}

function bullets(doc: string): string[] {
  return doc
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l && !/^no curated long-term memory yet\.?$/i.test(l));
}

/** The next time `hh:mm` happens in `tz` at or after `after`, optionally on a given weekday (0 = Sunday). */
function nextWallTime(time: string, tz: string, after: Date, weekday?: number): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const today = localParts(after, tz).date;
  for (let k = 0; k < 8; k++) {
    const date = shiftDate(today, k);
    if (weekday !== undefined && new Date(date + 'T12:00:00Z').getUTCDay() !== weekday) continue;
    const at = zonedToUtc(date, hour, minute, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

function routineInstruction(kind: string, name: string, config: Row): string {
  const prompt = str(config.prompt).trim() || str(config.goal).trim();
  if (prompt) return prompt;
  if (kind === 'learning.word_of_day') return 'Teach one useful word: the word, a one-line meaning, and a natural example sentence.';
  return name;
}

function routineSchedule(schedule: Row, tz: string, nextRunAt: string, now: Date): { fireAt: Date; recurrence: Recurrence } | null {
  const zone = isValidTimezone(str(schedule.timezone)) ? str(schedule.timezone) : tz;
  if (schedule.type === 'daily') {
    const fireAt = nextWallTime(str(schedule.time), zone, now);
    return fireAt ? { fireAt, recurrence: { freq: 'daily', interval: 1 } } : null;
  }
  if (schedule.type === 'weekly') {
    const dow = Number(schedule.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    const fireAt = nextWallTime(str(schedule.time), zone, now, dow);
    return fireAt ? { fireAt, recurrence: { freq: 'weekly', interval: 1, weekdays: [dow] } } : null;
  }
  if (schedule.type === 'interval') {
    const every = Math.round(Number(schedule.everyMinutes));
    if (!Number.isFinite(every) || every <= 0) return null;
    const recurrence: Recurrence = every % 60 === 0 ? { freq: 'hourly', interval: every / 60 } : { freq: 'minutely', interval: Math.max(5, every) };
    const planned = Date.parse(nextRunAt);
    const fireAt = Number.isFinite(planned) && planned > now.getTime() ? new Date(planned) : new Date(now.getTime() + every * 60_000);
    return { fireAt, recurrence };
  }
  return null;
}

/** People in the old tables who have not been imported yet. */
export function pendingLegacyUsers(db: Database.Database, store: Store): string[] {
  if (!hasTable(db, 'users')) return [];
  const rows = db.prepare('SELECT telegram_id FROM users ORDER BY id').all() as Row[];
  return rows.map((r) => str(r.telegram_id)).filter((k) => /^\d+$/.test(k) && !store.getState(k).importedLegacyDbAt);
}

export function importLegacyDbUser(db: Database.Database, store: Store, userKey: string, opts: { now?: Date; defaultTimezone?: string } = {}): LegacyDbReport {
  const now = opts.now ?? new Date();
  const report: LegacyDbReport = { userKey, profile: false, facts: 0, entries: 0, days: 0, reminders: 0 };
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userKey) as Row | undefined;
  if (!user) return { ...report, skipped: 'no such user' };
  if (store.getState(userKey).importedLegacyDbAt) return { ...report, skipped: 'already imported' };
  const userId = Number(user.id);

  const legacyProfile = hasTable(db, 'profiles') ? (db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId) as Row | undefined) : undefined;
  const docs = new Map<string, string>();
  if (hasTable(db, 'agent_workspace_docs')) {
    for (const d of db.prepare('SELECT doc_key, content_markdown FROM agent_workspace_docs WHERE user_id = ?').all(userId) as Row[]) docs.set(str(d.doc_key), str(d.content_markdown));
  }
  const userDoc = docs.get('USER.md') || '';
  const identityDoc = docs.get('IDENTITY.md') || '';

  const legacyTz = str(legacyProfile?.timezone);
  const fallbackTz = opts.defaultTimezone && isValidTimezone(opts.defaultTimezone) ? opts.defaultTimezone : 'UTC';
  const tz = isValidTimezone(legacyTz) ? legacyTz : fallbackTz;

  const run = db.transaction(() => {
    const profile = store.getProfile(userKey);
    const name = docField(userDoc, 'Preferred name') || (str(legacyProfile?.name).trim() !== 'Friend' ? str(legacyProfile?.name).trim() : '');
    const agentName = docField(identityDoc, 'Agent name');
    if (!profile.name && name) (profile.name = name.slice(0, 80)), (report.profile = true);
    if (!profile.agentName && agentName && agentName !== 'i-Journal') (profile.agentName = agentName.slice(0, 80)), (report.profile = true);
    if (!profile.timezone && isValidTimezone(legacyTz)) (profile.timezone = legacyTz), (report.profile = true);
    if (report.profile) store.saveProfile(userKey, profile);

    const facts: string[] = [];
    const given = docField(userDoc, 'Given name');
    if (given && given !== name) facts.push(`Given name: ${given}`);
    const also = [docField(userDoc, 'Nicknames'), docField(userDoc, 'Aliases')].filter(Boolean).join(', ');
    if (also) facts.push(`Also goes by: ${also}`);
    const areas = (parseJson<Array<{ title?: string }>>(legacyProfile?.sections_json) || []).map((s) => str(s.title).trim()).filter(Boolean);
    // The old app's untouched default list is not something they said.
    const untouchedDefault = areas.join('|').toLowerCase() === 'work|family|faith|personal';
    if (areas.length && !untouchedDefault) facts.push(`Areas of life they keep track of: ${areas.join(', ')}`);
    facts.push(...bullets(docs.get('MEMORY.md') || ''));
    for (const text of facts) if (store.addFact(userKey, 'fact', text.slice(0, 500), now).created) report.facts++;

    if (hasTable(db, 'journal_entries')) {
      const rows = db.prepare('SELECT * FROM journal_entries WHERE user_id = ? ORDER BY entry_date, created_at').all(userId) as Row[];
      const cloud = new Map<string, { all: boolean; url: string }>();
      for (const r of rows) {
        const date = str(r.entry_date);
        const text = str(r.content_markdown).trim();
        if (!isIsoDate(date) || !text) continue;
        const created = new Date(str(r.created_at));
        const at = Number.isFinite(created.getTime()) ? created : new Date(date + 'T12:00:00Z');
        store.addEntry(userKey, date, { text: text.slice(0, 20_000), media: [], at, localTime: localParts(at, tz).date === date ? localParts(at, tz).time : '--:--' });
        report.entries++;
        const c = cloud.get(date) || { all: true, url: '' };
        c.all = c.all && Number(r.saved_to_cloud) === 1;
        c.url = c.url || str(r.onenote_url);
        cloud.set(date, c);
      }
      report.days = cloud.size;
      // Days the old app already put in OneNote are not copied again (same page title, it would replace them).
      for (const [date, c] of cloud) if (c.all) store.markDaySynced(userKey, date, { at: now, remoteUrl: c.url || undefined });
    }

    if (hasTable(db, 'routines')) {
      for (const r of db.prepare('SELECT * FROM routines WHERE user_id = ? AND enabled = 1').all(userId) as Row[]) {
        const schedule = parseJson<Row>(r.schedule_json);
        const plan = schedule ? routineSchedule(schedule, tz, str(r.next_run_at), now) : null;
        if (!plan) continue;
        const text = routineInstruction(str(r.kind), str(r.name), parseJson<Row>(r.config_json) || {});
        store.addReminder(userKey, { kind: 'task', text: text.slice(0, 500), fireAt: plan.fireAt, recurrence: plan.recurrence }, now);
        report.reminders++;
      }
    }
    if (hasTable(db, 'pending_reminders')) {
      for (const r of db.prepare("SELECT * FROM pending_reminders WHERE user_id = ? AND kind = 'agent.custom_reminder'").all(userId) as Row[]) {
        const fireAt = new Date(str(r.fire_at));
        const message = str(parseJson<Row>(r.payload_json)?.message).trim();
        if (!message || !(fireAt.getTime() > now.getTime())) continue;
        store.addReminder(userKey, { kind: 'notify', text: message.slice(0, 500), fireAt }, now);
        report.reminders++;
      }
    }

    const state = store.getState(userKey);
    state.importedLegacyDbAt = now.toISOString();
    store.saveState(userKey, state);
  });
  run();
  return report;
}

/**
 * Imports everyone pending. Before the first import on a file database, a full copy is written next to
 * it (VACUUM INTO), so the switch can always be undone.
 */
export function importLegacyDb(db: Database.Database, store: Store, opts: { now?: Date; defaultTimezone?: string; log?: Logger; backup?: boolean } = {}): LegacyDbReport[] {
  const pending = pendingLegacyUsers(db, store);
  if (!pending.length) return [];
  if (opts.backup !== false && db.name && db.name !== ':memory:' && !db.memory) {
    const file = `${db.name}.before-core-${(opts.now ?? new Date()).toISOString().slice(0, 10)}.bak`;
    try {
      db.prepare('VACUUM INTO ?').run(file);
      opts.log?.info('legacy import: backup written', { file });
    } catch (err) {
      opts.log?.warn('legacy import: backup failed (continuing; old tables are never modified)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const reports: LegacyDbReport[] = [];
  for (const userKey of pending) {
    try {
      const r = importLegacyDbUser(db, store, userKey, opts);
      reports.push(r);
      opts.log?.info('legacy import', { ...r });
    } catch (err) {
      opts.log?.error('legacy import failed', { userKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}
