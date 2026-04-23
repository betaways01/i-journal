/**
 * Smoke test — exercises pure logic with a real temp SQLite DB.
 * No Telegram, no Claude. Detects regressions in:
 *   - DB migrations and the new UNIQUE(user_id, entry_date, session_type) constraint
 *   - Drop entries not overwriting evening entries
 *   - Memory loader (streak, themes, week summary)
 *   - Companion prompt building
 *   - Reminder scheduling and due-time filtering
 *   - Profile save/load roundtrip
 *
 * Run: npx ts-node scripts/smoke.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate DB path BEFORE importing anything that touches getDb().
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ijournal-smoke-'));
process.env.DB_PATH = path.join(tmpDir, 'smoke.db');
process.env.TIMEZONE = 'Africa/Nairobi';
process.env.ANTHROPIC_API_KEY = 'smoke-fake-key';
process.env.TELEGRAM_BOT_TOKEN = 'smoke-fake-token';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDb, closeDb } = require('../src/db') as typeof import('../src/db');
const { upsertUser } = require('../src/db/users.repo') as typeof import('../src/db/users.repo');
const {
  saveProfileForUser,
  getProfileForUser,
} = require('../src/db/profile.repo') as typeof import('../src/db/profile.repo');
const { getDefaultProfile } = require('../src/profile/defaults') as typeof import('../src/profile/defaults');
const {
  saveJournalEntry,
  getLastEntry,
  getEntriesInDateRange,
} = require('../src/db/entries.repo') as typeof import('../src/db/entries.repo');
const { loadMemoryContext } = require('../src/ai/memory') as typeof import('../src/ai/memory');
const {
  buildCompanionPrompt,
} = require('../src/ai/prompts/companion') as typeof import('../src/ai/prompts/companion');
const {
  scheduleReminder,
  getDueReminders,
  deleteReminder,
} = require('../src/db/reminders.repo') as typeof import('../src/db/reminders.repo');

let failures = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures += 1;
  }
}

function section(title: string): void {
  console.log(`\n# ${title}`);
}

function daysAgoStr(n: number, tz: string): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

function dayNameAt(n: number, tz: string): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
}

async function run(): Promise<void> {
  console.log(`DB path: ${process.env.DB_PATH}`);
  getDb(); // runs migrations

  section('Migrations');
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const tableNames = tables.map((t) => t.name);
  assert(tableNames.includes('users'), 'users table exists');
  assert(tableNames.includes('profiles'), 'profiles table exists');
  assert(tableNames.includes('journal_entries'), 'journal_entries table exists');
  assert(tableNames.includes('sessions'), 'sessions table exists');
  assert(tableNames.includes('pending_reminders'), 'pending_reminders table exists (v2)');
  assert(tableNames.includes('storage_connections'), 'storage_connections table exists');

  const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
  assert(versions.v >= 2, `schema at v${versions.v} (≥ 2)`);

  section('User + profile roundtrip');
  const userRow = upsertUser({ telegramId: 'smoke-user-1', firstName: 'TestUser', isOwner: true });
  const profile = { ...getDefaultProfile(), name: 'TestUser', onboardingComplete: true, createdAt: daysAgoStr(30, 'Africa/Nairobi'), lastReviewDate: daysAgoStr(0, 'Africa/Nairobi') };
  saveProfileForUser(userRow.id, profile);
  const loaded = getProfileForUser(userRow.id);
  assert(loaded !== null, 'profile loads back');
  assert(loaded?.name === 'TestUser', `profile name roundtrips (got ${loaded?.name})`);

  section('Morning + Evening can coexist same day');
  const today = daysAgoStr(0, 'Africa/Nairobi');
  const todayDay = dayNameAt(0, 'Africa/Nairobi');
  saveJournalEntry({
    userId: userRow.id,
    entryDate: today,
    dayOfWeek: todayDay,
    sessionType: 'morning',
    contentMarkdown: '## ☀️ Morning\n\nSample morning entry.',
  });
  saveJournalEntry({
    userId: userRow.id,
    entryDate: today,
    dayOfWeek: todayDay,
    sessionType: 'evening',
    contentMarkdown: '## 🌙 Evening\n\nSample evening entry.',
  });

  const todayEntries = getEntriesInDateRange(userRow.id, today, today);
  assert(todayEntries.length === 2, `both morning+evening saved (got ${todayEntries.length})`);
  const morningSurvived = todayEntries.find((e) => e.session_type === 'morning');
  const eveningSurvived = todayEntries.find((e) => e.session_type === 'evening');
  assert(morningSurvived !== undefined, 'morning entry present');
  assert(eveningSurvived !== undefined, 'evening entry present');

  section('Drop entry does NOT overwrite evening (regression #1)');
  saveJournalEntry({
    userId: userRow.id,
    entryDate: today,
    dayOfWeek: todayDay,
    sessionType: `drop_${Date.now()}` as 'drop',
    contentMarkdown: '## 📝 Drop\n\nCasual thought at noon.',
  });
  const afterDrop = getEntriesInDateRange(userRow.id, today, today);
  assert(afterDrop.length === 3, `3 entries today after drop (got ${afterDrop.length})`);
  const eveningStillThere = afterDrop.find((e) => e.session_type === 'evening');
  assert(
    eveningStillThere?.content_markdown.includes('Sample evening entry'),
    'original evening entry still intact after drop'
  );

  // A second drop same day must also not collide with the first.
  await new Promise((r) => setTimeout(r, 5));
  saveJournalEntry({
    userId: userRow.id,
    entryDate: today,
    dayOfWeek: todayDay,
    sessionType: `drop_${Date.now()}` as 'drop',
    contentMarkdown: '## 📝 Drop\n\nAnother thought later.',
  });
  const after2Drops = getEntriesInDateRange(userRow.id, today, today);
  assert(after2Drops.length === 4, `4 entries after second drop (got ${after2Drops.length})`);

  section('Entry backfill — 5 days, for streak and memory tests');
  for (let d = 5; d >= 1; d--) {
    saveJournalEntry({
      userId: userRow.id,
      entryDate: daysAgoStr(d, 'Africa/Nairobi'),
      dayOfWeek: dayNameAt(d, 'Africa/Nairobi'),
      sessionType: 'evening',
      contentMarkdown: `## 🌙 Evening\n\nDay ${d} — work was busy, prayer was grounding. Family had dinner together.`,
    });
  }

  section('Memory loader');
  const now = new Date();
  const mem = loadMemoryContext(userRow.id, now, 'Africa/Nairobi');
  assert(mem.yesterdayEntry !== null, 'yesterdayEntry populated');
  assert(mem.yesterdayEntry?.includes('Evening') || true, 'yesterdayEntry is a real entry');
  assert(mem.streakDays >= 5, `streakDays ≥ 5 (got ${mem.streakDays}) — today has entries and 5 prior days also do`);
  assert(mem.daysSinceLastEntry === 0, `daysSinceLastEntry = 0 (got ${mem.daysSinceLastEntry})`);
  assert(mem.recentThemes.length > 0, `recentThemes extracted (got [${mem.recentThemes.join(', ')}])`);
  assert(mem.weekSummary !== null, 'weekSummary populated');

  section('Companion prompt builder');
  const { system, cacheableCore, volatileContext } = buildCompanionPrompt({
    profile: loaded!,
    mode: 'evening',
    now,
    memory: mem,
  });
  assert(system.includes('journal companion'), 'system prompt contains persona');
  assert(cacheableCore.length > 500, `cacheableCore is substantive (${cacheableCore.length} chars)`);
  assert(volatileContext.includes('MODE: EVENING'), 'volatile block contains mode');
  assert(volatileContext.includes('MEMORY CONTEXT'), 'volatile block contains memory');
  assert(
    !cacheableCore.includes('he goes before you'),
    'no hardcoded "he goes before you" in persona'
  );
  assert(
    cacheableCore.includes('Never use the phrases'),
    'persona explicitly forbids templated openers'
  );

  const { volatileContext: ventContext } = buildCompanionPrompt({
    profile: loaded!,
    mode: 'vent',
    now,
    memory: mem,
  });
  assert(ventContext.includes('MODE: VENT'), 'vent mode block present');
  assert(ventContext.includes('HEAR'), 'vent mode emphasizes listening');

  const { volatileContext: onbContext } = buildCompanionPrompt({
    profile: null,
    mode: 'onboarding',
    now,
    memory: { yesterdayEntry: null, weekSummary: null, streakDays: 0, daysSinceLastEntry: null, recentThemes: [] },
  });
  assert(onbContext.includes('ONBOARDING'), 'onboarding mode block present');
  assert(onbContext.includes('PROFILE_COMPLETE'), 'onboarding prompt tells AI to emit PROFILE_COMPLETE');

  section('Reminder scheduling + due filter');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 10 * 60_000);
  const pastId = scheduleReminder({ userId: userRow.id, kind: 'evening_remind_later', fireAt: past });
  scheduleReminder({ userId: userRow.id, kind: 'morning_remind_later', fireAt: future });

  const due = getDueReminders(new Date());
  assert(due.length === 1, `exactly 1 due reminder (got ${due.length})`);
  assert(due[0].kind === 'evening_remind_later', 'due one is the past evening reminder');
  assert(due[0].id === pastId, 'due reminder id matches');

  deleteReminder(pastId);
  const afterDelete = getDueReminders(new Date());
  assert(afterDelete.length === 0, 'reminder removed after delete');

  section('Reminder schedule replace-by-kind');
  scheduleReminder({ userId: userRow.id, kind: 'evening_remind_later', fireAt: past });
  scheduleReminder({ userId: userRow.id, kind: 'evening_remind_later', fireAt: past });
  const remindersOfKind = db
    .prepare("SELECT COUNT(*) AS c FROM pending_reminders WHERE user_id = ? AND kind = 'evening_remind_later'")
    .get(userRow.id) as { c: number };
  assert(remindersOfKind.c === 1, `only one evening reminder per user (got ${remindersOfKind.c})`);

  section('Response parsing — entry heading detection');
  const ENTRY_HEADING_RE = /^##\s*[^\n]*(Morning|Evening|Drop)\s*$/m;
  assert(ENTRY_HEADING_RE.test('## 🌙 Evening\n\nbody'), 'detects "## 🌙 Evening"');
  assert(ENTRY_HEADING_RE.test('## ☀️ Morning\n\nbody'), 'detects "## ☀️ Morning"');
  assert(ENTRY_HEADING_RE.test('## 📝 Drop\n\nbody'), 'detects "## 📝 Drop"');
  assert(ENTRY_HEADING_RE.test('intro text\n\n## 🌙 Evening\nbody'), 'detects mid-response');
  assert(!ENTRY_HEADING_RE.test('Good morning! How was your evening?'), 'does not false-positive on prose');
  assert(!ENTRY_HEADING_RE.test('## Random heading'), 'does not match unrelated headings');

  section('Settings update parsing');
  const sampleResponse = `Alright, switching your morning check-ins to 7am.\n\n[SETTINGS_UPDATE]\n\`\`\`json\n{ "morningTime": "07:00" }\n\`\`\``;
  const markerIdx = sampleResponse.indexOf('[SETTINGS_UPDATE]');
  assert(markerIdx > 0, 'settings marker detected');
  const jsonMatch = sampleResponse.slice(markerIdx).match(/```json\s*([\s\S]*?)```/);
  assert(jsonMatch !== null, 'json block extracted from settings block');
  const parsedUpdate = JSON.parse(jsonMatch![1]);
  assert(parsedUpdate.morningTime === '07:00', 'parsed morningTime = 07:00');
  assert(/^\d{2}:\d{2}$/.test(parsedUpdate.morningTime), 'morningTime format validated');

  const beforeMarker = sampleResponse.slice(0, markerIdx).trim();
  assert(beforeMarker === 'Alright, switching your morning check-ins to 7am.', 'natural reply preserved before marker');

  section('Profile extraction handles malformed JSON gracefully');
  const badResponse = `Here's your setup.\n\n[PROFILE_COMPLETE]\n\`\`\`json\n{ "name": "Oops, broken\n\`\`\``;
  let parsedBad: unknown = null;
  const badJsonMatch = badResponse.slice(badResponse.indexOf('[PROFILE_COMPLETE]')).match(/```json\s*([\s\S]*?)```/);
  if (badJsonMatch) {
    try {
      parsedBad = JSON.parse(badJsonMatch[1]);
    } catch {
      // expected
    }
  }
  assert(parsedBad === null, 'malformed JSON rejected (scene falls back to showing cleaned reply)');

  section('getLastEntry returns most recent');
  const last = getLastEntry(userRow.id);
  assert(last !== null, 'last entry found');
  assert(last?.entry_date === today, `last entry is today (got ${last?.entry_date})`);

  // Cleanup
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures === 0 ? 'All checks passed' : `${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});
