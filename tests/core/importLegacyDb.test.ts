import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteStore } from '../../src/core/store';
import { importLegacyDb, importLegacyDbUser, pendingLegacyUsers } from '../../src/core/importLegacyDb';
import { NOW } from './helpers';

/** The original companion's tables, as its migrations created them. */
const LEGACY_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL UNIQUE, username TEXT, first_name TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0, onboarding_complete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE profiles (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL, sections_json TEXT NOT NULL, schedule_json TEXT NOT NULL,
    morning_time TEXT NOT NULL, evening_time TEXT NOT NULL, timezone TEXT NOT NULL, created_at TEXT NOT NULL, last_review_date TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, entry_date TEXT NOT NULL, day_of_week TEXT NOT NULL,
    session_type TEXT NOT NULL, content_markdown TEXT NOT NULL, onenote_url TEXT, saved_to_cloud INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE(user_id, entry_date, session_type));
  CREATE TABLE pending_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, fire_at TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL);
  CREATE TABLE routines (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    schedule_json TEXT NOT NULL, config_json TEXT, next_run_at TEXT NOT NULL, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE agent_workspace_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, doc_key TEXT NOT NULL, content_markdown TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, doc_key));
`;

function legacyDb(file = ':memory:'): Database.Database {
  const db = new Database(file);
  db.exec(LEGACY_SCHEMA);
  const t = '2026-09-01T00:00:00Z';
  db.prepare('INSERT INTO users (telegram_id, first_name, is_owner, onboarding_complete, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)').run('100000001', 'Sam', t, t);
  db.prepare('INSERT INTO users (telegram_id, first_name, is_owner, onboarding_complete, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)').run('100000002', 'Ana', t, t);
  db.prepare('INSERT INTO profiles VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(
    'Sammy',
    JSON.stringify([{ key: 'work', title: 'Boat repairs' }, { key: 'music', title: 'Music' }]),
    '{}',
    '06:00',
    '21:00',
    'Asia/Riyadh',
    t,
    t
  );
  db.prepare('INSERT INTO profiles VALUES (2, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run('Friend', '[]', '{}', '06:00', '21:00', 'Not/AZone', t, t);
  const doc = (u: number, key: string, content: string) => db.prepare('INSERT INTO agent_workspace_docs (user_id, doc_key, content_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(u, key, content, t, t);
  doc(1, 'USER.md', '# USER.md\n\nPreferred name: Sam\nGiven name: Samuel\nNicknames: Captain\nAliases: none yet\nTimezone: Asia/Riyadh');
  doc(1, 'IDENTITY.md', '# IDENTITY.md\n\nAgent name: Kibo\n');
  doc(1, 'MEMORY.md', '# MEMORY.md\n\n## Durable Facts\n- Has two kids, Ana and Leo\n- Fixes boat engines in Porto\n');
  doc(2, 'MEMORY.md', '# MEMORY.md\n\nNo curated long-term memory yet.');
  const entry = (u: number, date: string, type: string, text: string, cloud: number, at: string) =>
    db.prepare('INSERT INTO journal_entries (user_id, entry_date, day_of_week, session_type, content_markdown, onenote_url, saved_to_cloud, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      u, date, 'x', type, text, cloud ? 'https://onenote.example/' + date : null, cloud, at
    );
  entry(1, '2026-09-28', 'morning', '## Morning\nSlept well. Big day.', 1, '2026-09-28T04:10:00Z');
  entry(1, '2026-09-28', 'evening', '## Evening\nThe engine finally ran.', 1, '2026-09-28T18:30:00Z');
  entry(1, '2026-09-29', 'evening', 'Rough day with the client.', 0, '2026-09-29T19:00:00Z');
  const routine = (u: number, kind: string, name: string, enabled: number, schedule: object, config: object, next: string) =>
    db.prepare('INSERT INTO routines (user_id, kind, name, enabled, schedule_json, config_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      u, kind, name, enabled, JSON.stringify(schedule), JSON.stringify(config), next, t, t
    );
  routine(1, 'agent.custom_prompt', 'Morning push', 1, { type: 'daily', time: '06:30', timezone: 'Asia/Riyadh' }, { prompt: 'Send a short, warm push for the day.' }, '2026-09-01T03:30:00Z');
  routine(1, 'learning.word_of_day', 'Word', 1, { type: 'weekly', dayOfWeek: 1, time: '09:00', timezone: 'Asia/Riyadh' }, {}, '2026-09-01T06:00:00Z');
  routine(1, 'agent.custom_prompt', 'Water', 1, { type: 'interval', everyMinutes: 120, timezone: 'Asia/Riyadh' }, { prompt: 'Remind me to drink water.' }, '2026-10-02T13:00:00Z');
  routine(1, 'agent.custom_prompt', 'Old', 0, { type: 'daily', time: '07:00', timezone: 'Asia/Riyadh' }, { prompt: 'never' }, '2026-09-01T04:00:00Z');
  const rem = (u: number, kind: string, at: string, payload: object) => db.prepare('INSERT INTO pending_reminders (user_id, kind, fire_at, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(u, kind, at, JSON.stringify(payload), t);
  rem(1, 'agent.custom_reminder', '2026-10-03T07:00:00Z', { message: 'Call the harbour office' });
  rem(1, 'agent.custom_reminder', '2026-09-30T07:00:00Z', { message: 'Already past' });
  rem(1, 'evening_nudge', '2026-10-02T18:00:00Z', {});
  return db;
}

test('imports profile, memory, journal, routines and reminders from the original tables', () => {
  const db = legacyDb();
  const store = new SqliteStore(new Database(':memory:'));
  assert.deepEqual(pendingLegacyUsers(db, store), ['100000001', '100000002']);
  const r = importLegacyDbUser(db, store, '100000001', { now: NOW });
  assert.deepEqual({ ...r }, { userKey: '100000001', profile: true, facts: 5, entries: 3, days: 2, reminders: 4 });

  assert.deepEqual(store.getProfile('100000001'), { name: 'Sam', agentName: 'Kibo', timezone: 'Asia/Riyadh' });
  assert.deepEqual(store.listFacts('100000001').map((f) => f.text).sort(), [
    'Also goes by: Captain',
    'Areas of life they keep track of: Boat repairs, Music',
    'Fixes boat engines in Porto',
    'Given name: Samuel',
    'Has two kids, Ana and Leo',
  ]);

  const d28 = store.getDay('100000001', '2026-09-28')!;
  assert.deepEqual(d28.entries.map((e) => [e.localTime, e.text]), [
    ['07:10', '## Morning\nSlept well. Big day.'],
    ['21:30', '## Evening\nThe engine finally ran.'],
  ]);
  assert.deepEqual(store.dirtyDays('100000001').map((d) => d.date), ['2026-09-29'], 'days already in OneNote are not copied again');

  const reminders = store.listReminders('100000001');
  const byText = (t: string) => reminders.find((x) => x.text === t)!;
  assert.equal(byText('Send a short, warm push for the day.').fireAt, '2026-10-03T03:30:00.000Z', 'daily 06:30 local, next occurrence');
  assert.deepEqual(byText('Send a short, warm push for the day.').recurrence, { freq: 'daily', interval: 1 });
  assert.equal(byText('Send a short, warm push for the day.').kind, 'task');
  const word = byText('Teach one useful word: the word, a one-line meaning, and a natural example sentence.');
  assert.equal(word.fireAt, '2026-10-05T06:00:00.000Z', 'next Monday 09:00 local');
  assert.deepEqual(word.recurrence, { freq: 'weekly', interval: 1, weekdays: [1] });
  assert.deepEqual(byText('Remind me to drink water.').recurrence, { freq: 'hourly', interval: 2 });
  assert.equal(byText('Remind me to drink water.').fireAt, '2026-10-02T13:00:00.000Z', 'keeps a future planned run');
  assert.equal(byText('Call the harbour office').kind, 'notify');
  assert.ok(!reminders.some((x) => /never|Already past/.test(x.text)), 'disabled routines and past reminders are skipped');

  assert.equal(importLegacyDbUser(db, store, '100000001', { now: NOW }).skipped, 'already imported');
  assert.equal(store.listReminders('100000001').length, 4, 'never imported twice');
});

test('placeholders and bad values are ignored; the deployment timezone is the fallback', () => {
  const db = legacyDb();
  const store = new SqliteStore(new Database(':memory:'));
  const r = importLegacyDbUser(db, store, '100000002', { now: NOW, defaultTimezone: 'Europe/Lisbon' });
  assert.deepEqual({ ...r }, { userKey: '100000002', profile: false, facts: 0, entries: 0, days: 0, reminders: 0 });
  assert.deepEqual(store.getProfile('100000002'), { name: '', agentName: '', timezone: '' }, '"Friend" and an invalid zone are not real values');
});

test('import marker survives /reset everything, so old data never comes back by itself', () => {
  const db = legacyDb();
  const store = new SqliteStore(new Database(':memory:'));
  importLegacyDbUser(db, store, '100000001', { now: NOW });
  store.wipeUser('100000001', 'all');
  assert.deepEqual(pendingLegacyUsers(db, store), ['100000002']);
  assert.equal(store.listDays('100000001').length, 0);
});

test('importLegacyDb backs up a file database first and imports everyone pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ij-legacy-'));
  const file = path.join(dir, 'i-journal.db');
  const db = legacyDb(file);
  const store = new SqliteStore(db);
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const reports = importLegacyDb(db, store, { now: NOW, log });
  assert.equal(reports.length, 2);
  const backup = path.join(dir, 'i-journal.db.before-core-2026-10-02.bak');
  assert.ok(fs.existsSync(backup), 'backup written');
  const copy = new Database(backup, { readonly: true });
  assert.equal((copy.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c, 3);
  copy.close();
  assert.deepEqual(importLegacyDb(db, store, { now: NOW, log }), [], 'nothing pending the second time');
  assert.ok(logs.includes('legacy import: backup written'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database without the old tables imports nothing', () => {
  const store = new SqliteStore(new Database(':memory:'));
  assert.deepEqual(importLegacyDb(new Database(':memory:'), store), []);
});
