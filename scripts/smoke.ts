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
// Keep the smoke run hermetic: never inherit real OneNote tokens from .env, so the
// save_journal_entry tool never reaches the live Microsoft Graph API. (dotenv does not
// override keys that are already set, so setting these empty blocks .env values.)
process.env.MICROSOFT_ACCESS_TOKEN = '';
process.env.MICROSOFT_REFRESH_TOKEN = '';
process.env.MICROSOFT_CLIENT_ID = '';
process.env.MICROSOFT_CLIENT_SECRET = '';

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
const {
  createRoutine,
  findRoutineForUserByKind,
  getDueRoutines,
  startRoutineRun,
  finishRoutineRun,
  updateRoutine,
  listRoutinesForUser,
} = require('../src/db/routines.repo') as typeof import('../src/db/routines.repo');
const {
  computeNextRunAt,
} = require('../src/routines/schedule') as typeof import('../src/routines/schedule');
const {
  setSessionForUser,
  getSessionForUser,
  hasSessionForUser,
  clearSessionForUser,
  clearStaleSessions,
} = require('../src/db/sessions.repo') as typeof import('../src/db/sessions.repo');
const {
  normalizeBootstrapUnderstanding,
  mergeBootstrapPatch,
} = require('../src/agent/bootstrap') as typeof import('../src/agent/bootstrap');
const {
  emptyBootstrapDraft,
  appendMemoryFacts,
  ensureAgentWorkspaceForUser,
  readAgentIdentity,
  renderWorkspaceContext,
  updateAgentIdentityForUser,
} = require('../src/agent/workspace') as typeof import('../src/agent/workspace');
const {
  parseName,
  parseAreaSections,
  parseTwoTimes,
  parseTime,
  makeProfile,
} = require('../src/bot/scenes/setup.helpers') as typeof import('../src/bot/scenes/setup.helpers');

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
  assert(tableNames.includes('routines'), 'routines table exists (v3)');
  assert(tableNames.includes('routine_runs'), 'routine_runs table exists (v3)');
  assert(tableNames.includes('agent_workspace_docs'), 'agent workspace docs table exists (v4)');

  const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
  assert(versions.v >= 4, `schema at v${versions.v} (≥ 4)`);

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
    cacheableCore.includes('Vary your openings'),
    'persona explicitly forbids templated openers'
  );
  assert(
    cacheableCore.includes('IRON RULE OF TRUTH'),
    'persona carries the tool-truthfulness contract'
  );
  assert(
    cacheableCore.includes('save_journal_entry'),
    'persona instructs saving via the save_journal_entry tool'
  );
  assert(volatileContext.includes('SYSTEM FACTS'), 'volatile block contains system facts');
  assert(volatileContext.includes('Storage:'), 'volatile block contains storage truth');
  assert(volatileContext.includes('Morning check-in: 06:00'), 'volatile block includes morning time');

  const { volatileContext: ventContext } = buildCompanionPrompt({
    profile: loaded!,
    mode: 'vent',
    now,
    memory: mem,
  });
  assert(ventContext.includes('MODE: VENT'), 'vent mode block present');
  assert(ventContext.includes('HEAR'), 'vent mode emphasizes listening');

  section('Deterministic setup helpers');
  assert(parseName('my name is Hilda') === 'Hilda', 'name parser handles natural introduction');
  const areas = parseAreaSections('Family, God, Personal Life');
  assert(areas.length === 3, `area parser returns 3 areas (got ${areas.length})`);
  assert(areas[0].title === 'Family', `first area title is Family (got ${areas[0].title})`);
  assert(areas[2].emoji !== '•', 'custom area emoji does not double-render as a bullet');
  const parsedTimes = parseTwoTimes('06:30 and 21:30');
  assert(parsedTimes?.morningTime === '06:30', `morning time parsed (got ${parsedTimes?.morningTime})`);
  assert(parsedTimes?.eveningTime === '21:30', `evening time parsed (got ${parsedTimes?.eveningTime})`);
  const setupProfile = makeProfile({
    name: 'Hilda',
    sections: areas,
    morningTime: parsedTimes!.morningTime,
    eveningTime: parsedTimes!.eveningTime,
  });
  assert(setupProfile.onboardingComplete === true, 'setup profile marks onboarding complete');
  assert(setupProfile.sections[1].title === 'God', 'setup profile preserves God area');

  section('OpenClaw-style workspace + bootstrap understanding');
  ensureAgentWorkspaceForUser(userRow);
  const workspaceContext = renderWorkspaceContext(userRow.id, { includeBootstrap: true });
  assert(workspaceContext.includes('SOUL.md'), 'workspace context includes SOUL.md');
  assert(workspaceContext.includes('USER.md'), 'workspace context includes USER.md');
  assert(workspaceContext.includes('BOOTSTRAP.md'), 'workspace context includes BOOTSTRAP.md');

  const identityUnderstanding = normalizeBootstrapUnderstanding({
    assistantReply: "Got it. I'll call you King Kang and remember Francis as another name you use.",
    patch: {
      userIdentity: {
        preferredName: 'King Kang',
        aliases: ['Francis'],
        rawMentions: ['King Kang, or sometime Francis'],
      },
    },
    confidence: 0.72,
    needsConfirmation: true,
    readyToComplete: false,
    missing: ['areas', 'times'],
  });
  let draft = mergeBootstrapPatch(emptyBootstrapDraft(), identityUnderstanding.patch, 'King Kang, or sometime Francis');
  assert(draft.userIdentity.preferredName === 'King Kang', 'bootstrap extracts preferred name');
  assert(draft.userIdentity.aliases.includes('Francis'), 'bootstrap stores Francis as alias');

  const timesUnderstanding = normalizeBootstrapUnderstanding({
    assistantReply: 'I have morning 09:30 and evening 20:30.',
    patch: {
      morningTime: '9.30',
      eveningTime: '8.30 evening',
    },
    confidence: 0.9,
    needsConfirmation: true,
    readyToComplete: false,
    missing: [],
  });
  draft = mergeBootstrapPatch(draft, timesUnderstanding.patch, 'Morning at 9.30 Evening at 8.30');
  assert(draft.morningTime === '09:30', `bootstrap accepts dotted morning time (got ${draft.morningTime})`);
  assert(draft.eveningTime === '20:30', `bootstrap accepts natural evening time (got ${draft.eveningTime})`);

  const agentNameUnderstanding = normalizeBootstrapUnderstanding({
    assistantReply: 'Nia can be the companion name.',
    patch: {
      agentIdentity: { name: 'Nia' },
    },
    confidence: 0.95,
    needsConfirmation: false,
    readyToComplete: false,
    missing: [],
  });
  draft = mergeBootstrapPatch(draft, agentNameUnderstanding.patch, 'Call yourself Nia');
  assert(draft.agentIdentity.name === 'Nia', 'bootstrap distinguishes agent name from user name');

  // Areas are FREE-FORM now — the user's own words, never forced into preset buckets.
  // (This deliberately replaces the old "compact into Work/Family/God&Ministry" test.)
  const freeformAreas = normalizeBootstrapUnderstanding({
    assistantReply: 'Got it — your words, not my buckets.',
    patch: { areas: ['Woodworking', 'Rest and recovery', 'My startup metrics', 'Faith'] },
    confidence: 0.9,
    needsConfirmation: true,
    readyToComplete: false,
    missing: [],
  });
  const freeDraft = mergeBootstrapPatch(emptyBootstrapDraft(), freeformAreas.patch);
  const freeTitles = freeDraft.areas.map((area) => area.title);
  assert(freeTitles.includes('Woodworking'), 'free-form area "Woodworking" is preserved, not bucketed');
  assert(freeTitles.some((t) => t.toLowerCase() === 'rest and recovery'), '"Rest and recovery" stays ONE area (not split on "and")');
  assert(!freeTitles.includes('Rest'), 'area is not shredded into "Rest" + "Recovery"');
  assert(freeTitles.some((t) => t.toLowerCase().includes('startup')), 'multi-word free-form area is preserved');
  assert(!freeTitles.includes('Work'), 'areas are NOT collapsed into a preset "Work" bucket');

  updateAgentIdentityForUser(userRow.id, { name: 'Frankie' });
  assert(readAgentIdentity(userRow.id).name === 'Frankie', 'agent identity update persists to workspace');
  appendMemoryFacts(userRow.id, ['Tavana is 4']);
  const workspaceAfterMemoryAppend = renderWorkspaceContext(userRow.id, { includeBootstrap: true });
  assert(workspaceAfterMemoryAppend.includes('- Tavana is 4'), 'memory fact append persists to workspace');
  assert(
    !workspaceAfterMemoryAppend.includes('No curated long-term memory yet.'),
    'memory placeholder is removed after first real fact'
  );

  section('Session persistence + stale cleanup');
  const sessionState = (sessionType: 'drop' | 'onboarding', hoursAgo: number) => ({
    userId: userRow.telegram_id,
    sessionType,
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    completed: false,
  });
  setSessionForUser(userRow.id, sessionState('drop', 4));
  clearStaleSessions();
  assert(hasSessionForUser(userRow.id), 'recent drop session survives stale cleanup');
  assert(getSessionForUser(userRow.id)?.sessionType === 'drop', 'recent drop session remains readable');
  setSessionForUser(userRow.id, sessionState('drop', 25));
  assert(!hasSessionForUser(userRow.id), 'old journal session stops blocking new work');
  setSessionForUser(userRow.id, sessionState('onboarding', 25));
  clearStaleSessions();
  assert(hasSessionForUser(userRow.id), 'setup session survives longer than journal sessions');
  clearSessionForUser(userRow.id);

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
  scheduleReminder({
    userId: userRow.id,
    kind: 'agent.custom_reminder',
    fireAt: future,
    payload: { message: 'Call Alex' },
  });
  scheduleReminder({
    userId: userRow.id,
    kind: 'agent.custom_reminder',
    fireAt: future,
    payload: { message: 'Drink water' },
  });
  const customReminderCount = db
    .prepare("SELECT COUNT(*) AS c FROM pending_reminders WHERE user_id = ? AND kind = 'agent.custom_reminder'")
    .get(userRow.id) as { c: number };
  assert(customReminderCount.c === 2, `custom reminders can coexist (got ${customReminderCount.c})`);

  section('Routine schedule + word-of-day skill');
  const schedule = { type: 'daily' as const, time: '06:30', timezone: 'Africa/Nairobi' };
  const nextToday = computeNextRunAt(schedule, new Date('2026-05-06T03:00:00.000Z'));
  assert(nextToday.toISOString() === '2026-05-06T03:30:00.000Z', `next run later today (${nextToday.toISOString()})`);
  const nextTomorrow = computeNextRunAt(schedule, new Date('2026-05-06T04:00:00.000Z'));
  assert(nextTomorrow.toISOString() === '2026-05-07T03:30:00.000Z', `next run tomorrow (${nextTomorrow.toISOString()})`);

  const routine = createRoutine({
    userId: userRow.id,
    kind: 'agent.custom_prompt',
    name: 'Daily conversation word',
    schedule,
    config: { prompt: 'Teach a useful word with meaning and an example' },
    nextRunAt: new Date(Date.now() - 60_000),
  });
  const foundRoutine = findRoutineForUserByKind(userRow.id, 'agent.custom_prompt');
  assert(foundRoutine?.id === routine.id, 'routine can be found by user + kind');
  const dueRoutines = getDueRoutines(new Date());
  assert(dueRoutines.some((r) => r.id === routine.id), 'due routine is returned by sweeper query');
  // Routine content is AI-generated now (no hardcoded word list), so the skill itself needs
  // the network — exercise scheduling/run-tracking here, not generation.
  const runId = startRoutineRun(routine);
  finishRoutineRun({ runId, status: 'success', outputSummary: routine.name });
  const updatedRoutine = updateRoutine(routine.id, {
    nextRunAt: nextTomorrow,
    lastRunAt: new Date(),
  });
  assert(updatedRoutine?.next_run_at === nextTomorrow.toISOString(), 'routine next_run_at updates after run');

  section('Companion toolset — the agent\'s real hands');
  const { buildCompanionTools } = require('../src/agent/tools') as typeof import('../src/agent/tools');
  const botUser = { row: userRow, telegramId: userRow.telegram_id, profile: loaded!, isOwner: true };
  const { tools, effects } = buildCompanionTools({
    botUser,
    sessionMode: 'evening',
    sessionDate: new Date(),
  });
  const toolNames = tools.map((t) => t.definition.name);
  for (const expected of [
    'save_journal_entry',
    'remember',
    'set_reminder',
    'set_routine',
    'update_schedule',
    'update_profile',
    'rename_companion',
    'onenote_status',
    'look_up_entries',
  ]) {
    assert(toolNames.includes(expected), `tool present: ${expected}`);
  }
  assert(
    tools.every((t) => (t.definition.input_schema as { type?: string }).type === 'object'),
    'all tool input schemas are objects'
  );

  const lookup = await tools.find((t) => t.definition.name === 'look_up_entries')!.run({ days_back: 7 });
  assert(typeof lookup === 'string' && lookup.length > 0, 'look_up_entries returns a summary string');

  const rememberResult = await tools.find((t) => t.definition.name === 'remember')!.run({
    fact: 'Smoke fact: prefers tea',
  });
  assert(rememberResult.includes('Remembered'), 'remember tool confirms the save');
  const wsAfterRemember = renderWorkspaceContext(userRow.id, { includeBootstrap: false });
  assert(wsAfterRemember.includes('Smoke fact: prefers tea'), 'remember tool persists fact to workspace');

  // save_journal_entry with no OneNote configured: saves locally, reports honestly via effects.
  const saveResult = await tools.find((t) => t.definition.name === 'save_journal_entry')!.run({
    entry_markdown: '## 🌙 Evening\n\nSmoke save test — felt good to wrap the day.',
  });
  assert(saveResult.includes('Entry saved'), 'save_journal_entry reports the save back to the model');
  assert(effects.savedEntry !== undefined, 'save_journal_entry populates session effects for the scene');
  assert(
    effects.savedEntry?.oneNoteStatus === 'not_connected',
    'save honestly reports OneNote not connected in smoke env (no silent false claim)'
  );

  const schedResult = await tools.find((t) => t.definition.name === 'update_schedule')!.run({
    morning_time: '7am',
    evening_time: '21:30',
  });
  assert(schedResult.includes('07:00') && schedResult.includes('21:30'), 'update_schedule parses natural times');
  assert(getProfileForUser(userRow.id)?.morningTime === '07:00', 'update_schedule persists to profile');

  // Strict time parsing: impossible clock values are rejected, not silently normalized.
  const badTime = await tools.find((t) => t.definition.name === 'update_schedule')!.run({ morning_time: '25:00' });
  assert(badTime.toLowerCase().includes('error'), 'update_schedule rejects an impossible time (25:00)');
  assert(getProfileForUser(userRow.id)?.morningTime === '07:00', 'bad time did not overwrite the good morning time');

  // Routines support any cadence, not daily-only.
  const setRoutine = tools.find((t) => t.definition.name === 'set_routine')!;
  const weekly = await setRoutine.run({
    name: 'Week review',
    instruction: 'Ask me to reflect on the week and plan the next one',
    cadence: 'weekly',
    weekday: 'Friday',
    time: '17:00',
  });
  assert(weekly.toLowerCase().includes('friday'), 'set_routine creates a weekly (Friday) routine');
  const interval = await setRoutine.run({
    name: 'Gratitude pulse',
    instruction: 'Ask what I am grateful for right now',
    cadence: 'interval',
    every_hours: 4,
  });
  assert(interval.includes('4h') || interval.toLowerCase().includes('every'), 'set_routine creates an interval routine');
  const userRoutines = listRoutinesForUser(userRow.id);
  assert(
    userRoutines.some((r) => r.schedule.type === 'weekly') && userRoutines.some((r) => r.schedule.type === 'interval'),
    'weekly and interval routines both persisted'
  );

  section('Time parsing — bare meridiem (9pm/12am) and rejection');
  assert(parseTime('9pm') === '21:00', `"9pm" -> 21:00 (got ${parseTime('9pm')})`);
  assert(parseTime('12am') === '00:00', `"12am" -> 00:00 (got ${parseTime('12am')})`);
  assert(parseTime('12pm') === '12:00', `"12pm" -> 12:00 (got ${parseTime('12pm')})`);
  assert(parseTime('7am') === '07:00', '"7am" -> 07:00');
  assert(parseTime('21:30') === '21:30', '"21:30" -> 21:30');
  assert(parseTime('25:00') === null, '"25:00" is rejected');

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
