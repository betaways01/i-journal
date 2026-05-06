import { Context } from 'telegraf';
import { companionTurn, withTyping } from '../../ai';
import {
  buildCompanionPrompt,
  CompanionMode,
  MemoryContext,
} from '../../ai/prompts/companion';
import { loadMemoryContext } from '../../ai/memory';
import { formatDateForJournal } from '../../ai/prompts/dayConfig';
import { sessionStore, updateJournalState } from '../../state/session.store';
import { ConversationState, SessionType } from '../../types';
import { loadBotUser, BotUser } from '../userContext';
import {
  saveJournalEntry,
  markEntrySavedToCloud,
  getEntriesInDateRange,
} from '../../db/entries.repo';
import {
  getOneNoteStatusForUser,
  writeMorningToOneNoteForUser,
  writeEveningToOneNoteForUser,
} from '../../onenote/writer';
import { saveProfileForUser, getProfileForUser } from '../../db/profile.repo';
import { normalizeProfile, getDefaultProfile, Profile } from '../../profile/defaults';
import { config } from '../../config';
import { reloadScheduler } from '../../scheduler';
import { POST_SAVE_ACTIONS, DROP_INLINE_ACTIONS } from '../keyboards';
import {
  appendMemoryFacts,
  ensureAgentWorkspaceForUser,
  readAgentIdentity,
  renderWorkspaceContext,
  updateAgentIdentityForUser,
} from '../../agent/workspace';
import { parseTime, todayLocalDate } from './setup.helpers';

const PROFILE_MARKER = '[PROFILE_COMPLETE]';
const SETTINGS_MARKER = '[SETTINGS_UPDATE]';

type Stage = 'active' | 'compiled';

// Strict: `## 🌙 Evening` / `## ☀️ Morning` / `## 📝 Drop` — nothing alphabetic between
// `##` and the mode word. Prevents prose headings like `## How was your Morning` from
// being mistaken for a compiled entry heading and saved as gibberish.
const ENTRY_HEADING_RE = /^##\s+[^a-zA-Z\n]+\s*(Morning|Evening|Drop)\s*$/m;

interface StartOptions {
  mode: CompanionMode;
  targetDate?: Date;
  initialUserMessage?: string;
  continuation?: boolean;
}

function sessionTypeFor(mode: CompanionMode): SessionType {
  if (mode === 'morning') return 'morning';
  if (mode === 'evening') return 'evening';
  if (mode === 'onboarding') return 'onboarding';
  if (mode === 'vent') return 'vent';
  return 'drop';
}

function modeEmoji(mode: CompanionMode): string {
  switch (mode) {
    case 'morning': return '☀️';
    case 'evening': return '🌙';
    case 'onboarding': return '🌱';
    case 'vent': return '💭';
    default: return '📝';
  }
}

function resolveMode(state: ConversationState): CompanionMode {
  if (state.sessionType === 'morning') return 'morning';
  if (state.sessionType === 'evening') return 'evening';
  if (state.sessionType === 'onboarding') return 'onboarding';
  if (state.sessionType === 'vent') return 'vent';
  return 'drop';
}

function withoutReplyContext(text: string): string {
  return text.replace(/^\[replying to:[\s\S]*?\]\n/i, '').trim();
}

function cleanNameCandidate(value: string): string {
  return value
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 50);
}

function extractAgentNameChange(text: string): string | null {
  const cleaned = withoutReplyContext(text);
  const patterns = [
    /\b(?:change|rename|set|make)\s+(?:your|the bot'?s|the companion'?s|companion)\s+(?:name\s+)?(?:to|as)\s+([a-zA-Z][a-zA-Z0-9 '\-]{1,50})/i,
    /\b(?:call yourself|name yourself|your name is|i'?ll call you|you are now|you're now)\s+([a-zA-Z][a-zA-Z0-9 '\-]{1,50})/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) return cleanNameCandidate(match[1]);
  }
  return null;
}

function impliesMissingAgentRename(text: string): boolean {
  const cleaned = withoutReplyContext(text);
  return /\b(i changed your name|changed your name|renamed you|gave you a name|i named you)\b/i.test(cleaned)
    && !extractAgentNameChange(cleaned);
}

function extractUserNameChange(text: string): string | null {
  const cleaned = withoutReplyContext(text);
  const match = cleaned.match(/\b(?:change|set|update)\s+my\s+name\s+(?:to|as)\s+([a-zA-Z][a-zA-Z0-9 '\-]{1,50})/i)
    ?? cleaned.match(/\b(?:call me|my name is)\s+([a-zA-Z][a-zA-Z0-9 '\-]{1,50})/i);
  return match?.[1] ? cleanNameCandidate(match[1]) : null;
}

function extractScheduleChange(text: string): { key: 'morningTime' | 'eveningTime'; time: string } | null {
  const cleaned = withoutReplyContext(text);
  const kind = /\bmorning\b/i.test(cleaned)
    ? 'morningTime'
    : /\b(evening|night|journal)\b/i.test(cleaned)
      ? 'eveningTime'
      : null;
  if (!kind) return null;
  const time = parseTime(cleaned);
  return time ? { key: kind, time } : null;
}

function extractMemoryFact(text: string): string | null {
  const cleaned = withoutReplyContext(text);
  const match = cleaned.match(/\b(?:remember|note|keep in mind)\s+(?:that\s+)?(.{4,180})/i);
  return match?.[1] ? match[1].trim().replace(/[.!?]+$/g, '') : null;
}

function isAgentNameQuestion(text: string): boolean {
  const cleaned = withoutReplyContext(text);
  return /\b(what('?s| is) your name|who are you|what should i call you)\b/i.test(cleaned);
}

function isDateTimeQuestion(text: string): boolean {
  const cleaned = withoutReplyContext(text);
  return /\b(what('?s| is) (the )?(date|day|time)|when is today|what day is it|what date is it)\b/i.test(cleaned);
}

function isUsageGuidanceQuestion(text: string): boolean {
  const cleaned = withoutReplyContext(text);
  return /\b(what can you do|how (do|can) i use|help me use|how can you help|achieve more|use you better|weaker areas|weak areas|improve with you)\b/i.test(cleaned);
}

async function handleImmediateAgentAction(
  ctx: Context,
  botUser: BotUser,
  text: string,
  state: ConversationState
): Promise<boolean> {
  if (state.flow?.name === 'agent_action' && state.flow.step === 'agent_name') {
    const name = cleanNameCandidate(withoutReplyContext(text));
    if (name && name.length >= 2) {
      const identity = updateAgentIdentityForUser(botUser.row.id, { name });
      sessionStore.set(botUser.telegramId, {
        ...state,
        flow: undefined,
      });
      await ctx.reply(`Got it - I'm ${identity.name} now. Thanks for the reminder, ${botUser.profile.name}.`);
      return true;
    }
  }

  if (impliesMissingAgentRename(text)) {
    sessionStore.set(botUser.telegramId, {
      ...state,
      flow: {
        name: 'agent_action',
        step: 'agent_name',
        data: {},
      },
    });
    await ctx.reply("You're right - what name should I use?");
    return true;
  }

  const agentRename = extractAgentNameChange(text);
  if (agentRename) {
    const identity = updateAgentIdentityForUser(botUser.row.id, { name: agentRename });
    await ctx.reply(`Got it - I'm ${identity.name} now. Thanks for naming me properly.`);
    return true;
  }

  const userRename = extractUserNameChange(text);
  if (userRename) {
    const current = getProfileForUser(botUser.row.id);
    if (current) {
      saveProfileForUser(botUser.row.id, {
        ...current,
        name: userRename,
        lastReviewDate: todayLocalDate(current.timezone),
        onboardingComplete: true,
      });
      await ctx.reply(`Got it - I'll call you ${userRename}.`);
      return true;
    }
  }

  const scheduleChange = extractScheduleChange(text);
  if (scheduleChange) {
    const current = getProfileForUser(botUser.row.id);
    if (current) {
      const updated = {
        ...current,
        [scheduleChange.key]: scheduleChange.time,
        lastReviewDate: todayLocalDate(current.timezone),
        onboardingComplete: true,
      };
      saveProfileForUser(botUser.row.id, updated);
      reloadScheduler();
      await ctx.reply(
        `${scheduleChange.key === 'morningTime' ? 'Morning check-in' : 'Evening journal'} moved to ${scheduleChange.time}.`
      );
      return true;
    }
  }

  const memoryFact = extractMemoryFact(text);
  if (memoryFact) {
    appendMemoryFacts(botUser.row.id, [memoryFact]);
    await ctx.reply("I'll remember that.");
    return true;
  }

  if (isAgentNameQuestion(text)) {
    const identity = readAgentIdentity(botUser.row.id);
    await ctx.reply(`I'm ${identity.name ?? 'i-Journal'} - your journal companion.`);
    return true;
  }

  if (isDateTimeQuestion(text)) {
    const now = new Date();
    const date = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: botUser.profile.timezone,
    });
    const time = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: botUser.profile.timezone,
    });
    await ctx.reply(`It's ${date}, ${time}.`);
    return true;
  }

  if (isUsageGuidanceQuestion(text)) {
    await ctx.reply(
      [
        'Use me in three ways:',
        '',
        '1. Journal normally: tell me what happened, even messily.',
        '2. Ask me to remember things: people, projects, routines, weak spots.',
        '3. Ask for help: "help me be better with family", "teach me a word daily", "remind me to pray on Wednesdays".',
        '',
        'When I notice a weaker area, I can gently nudge you with one useful thought, not a lecture.'
      ].join('\n')
    );
    return true;
  }

  return false;
}

function detectEntry(response: string): { found: boolean; index: number } {
  const match = response.match(ENTRY_HEADING_RE);
  if (!match || match.index === undefined) return { found: false, index: -1 };
  return { found: true, index: match.index };
}

function splitReplyAndEntry(response: string): { reply: string; entry: string } {
  const { found, index } = detectEntry(response);
  if (!found) return { reply: response.trim(), entry: '' };
  return {
    reply: response.slice(0, index).trim(),
    entry: response.slice(index).trim(),
  };
}

function computeStreakDays(userId: number, anchor: Date, timezone: string): number {
  const anchorStr = anchor.toLocaleDateString('en-CA', { timeZone: timezone });
  const thirtyDaysBefore = new Date(anchor);
  thirtyDaysBefore.setDate(thirtyDaysBefore.getDate() - 30);
  const start = thirtyDaysBefore.toLocaleDateString('en-CA', { timeZone: timezone });

  const entries = getEntriesInDateRange(userId, start, anchorStr);
  const distinctDates = new Set(entries.map((e) => e.entry_date));

  let streak = 0;
  const cursor = new Date(anchor);
  for (let i = 0; i < 30; i++) {
    const cursorStr = cursor.toLocaleDateString('en-CA', { timeZone: timezone });
    if (distinctDates.has(cursorStr)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function buildSaveConfirmation(mode: CompanionMode, streakDays: number, oneNoteUrl: string | null): string {
  const emoji = modeEmoji(mode);
  const parts = [`${emoji} Saved ✓`];

  if (streakDays >= 3) {
    const flame = streakDays >= 7 ? ' 🔥' : '';
    parts.push(` — ${streakDays} days in a row${flame}`);
  } else if (streakDays === 2) {
    parts.push(' — day 2 ✨');
  }

  let msg = parts.join('');
  if (oneNoteUrl) {
    msg += `\n[Open in OneNote](${oneNoteUrl})`;
  }
  return msg;
}

async function reactToUserMessage(ctx: Context, emoji: string): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    const messageId = (ctx.message as { message_id?: number })?.message_id;
    if (!chatId || !messageId) return;

    await (ctx.telegram as unknown as {
      callApi: (
        method: string,
        payload: Record<string, unknown>
      ) => Promise<unknown>;
    }).callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
      is_big: false,
    });
  } catch {
    // Reactions are a nice-to-have — ignore failures silently.
  }
}

async function loadMemoryFor(botUser: BotUser, now: Date): Promise<MemoryContext> {
  return loadMemoryContext(botUser.row.id, now, botUser.profile.timezone);
}

async function buildSystemFor(
  botUser: BotUser | null,
  mode: CompanionMode,
  now: Date,
  memory: MemoryContext,
  catchUpDate?: Date
): Promise<{ cacheableCore: string; volatileContext: string }> {
  const storageSummary = botUser
    ? getOneNoteStatusForUser(botUser.row).connected
      ? 'Entries save first to the private SQLite database. OneNote backup/sync is connected for this account.'
      : 'Entries save first to the private SQLite database. OneNote backup is optional and not connected for this account.'
    : 'During setup, no journal entries are saved yet. After setup, entries save first to the private SQLite database.';
  const workspaceContext = botUser
    ? (ensureAgentWorkspaceForUser(botUser.row), renderWorkspaceContext(botUser.row.id, {
        includeBootstrap: botUser.row.onboarding_complete === 0,
      }))
    : undefined;

  const { cacheableCore, volatileContext } = buildCompanionPrompt({
    profile: botUser?.profile ?? null,
    mode,
    now,
    memory,
    catchUpDate,
    storageSummary,
    workspaceContext,
  });
  return { cacheableCore, volatileContext };
}

async function saveCompiledEntry(
  ctx: Context,
  botUser: BotUser,
  mode: CompanionMode,
  entryMarkdown: string,
  sessionDate: Date
): Promise<void> {
  const { dateStr, dayStr } = formatDateForJournal(sessionDate, botUser.profile.timezone);

  // Morning and evening are unique per day; drops are free-floating so they get a
  // timestamp-suffixed session_type to avoid the UNIQUE(user_id, entry_date, session_type)
  // constraint clobbering existing morning/evening entries.
  const sessionTypeForSave: 'morning' | 'evening' | 'drop' =
    mode === 'morning' ? 'morning' : mode === 'evening' ? 'evening' : 'drop';

  const persistedSessionType =
    sessionTypeForSave === 'drop' ? (`drop_${Date.now()}` as 'drop') : sessionTypeForSave;

  const entryId = saveJournalEntry({
    userId: botUser.row.id,
    entryDate: dateStr,
    dayOfWeek: dayStr,
    sessionType: persistedSessionType,
    contentMarkdown: entryMarkdown,
  });

  if (mode === 'morning') {
    updateJournalState(String(botUser.row.telegram_id), { lastMorningDate: dateStr });
  } else if (mode === 'evening') {
    updateJournalState(String(botUser.row.telegram_id), { lastEveningDate: dateStr });
  }

  // For catchup (sessionDate < today), still anchor the streak on the most recent calendar day
  // so the user's real streak — which includes today if they already journaled it — is shown.
  const streakAnchor = sessionDate.getTime() > Date.now() - 12 * 60 * 60 * 1000 ? sessionDate : new Date();
  const streakDays = computeStreakDays(botUser.row.id, streakAnchor, botUser.profile.timezone);

  // Drops are intentionally local-only — they're casual, and we don't want them overwriting
  // an existing OneNote morning/evening page for the day.
  let oneNoteUrl: string | null = null;
  let cloudFailed = false;
  if ((mode === 'morning' || mode === 'evening') && getOneNoteStatusForUser(botUser.row).connected) {
    try {
      if (mode === 'morning') {
        oneNoteUrl = await writeMorningToOneNoteForUser(botUser.row, dateStr, dayStr, entryMarkdown);
      } else {
        oneNoteUrl = await writeEveningToOneNoteForUser(botUser.row, dateStr, dayStr, entryMarkdown);
      }
      if (oneNoteUrl) markEntrySavedToCloud(entryId, oneNoteUrl);
    } catch (err) {
      console.error('[Companion] OneNote save failed:', err);
      cloudFailed = true;
    }
  }

  await ctx.reply(entryMarkdown);

  void reactToUserMessage(ctx, mode === 'morning' ? '☀' : mode === 'evening' ? '🌙' : '✍');

  const confirmation = cloudFailed
    ? `${modeEmoji(mode)} Saved locally ✓ (cloud sync failed — your entry is safe)`
    : buildSaveConfirmation(mode, streakDays, oneNoteUrl);

  await ctx.reply(confirmation, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: POST_SAVE_ACTIONS },
  });
}

function extractProfileFromResponse(response: string, botUser: BotUser): Profile | null {
  const markerIndex = response.indexOf(PROFILE_MARKER);
  if (markerIndex === -1) return null;

  const jsonMatch = response.slice(markerIndex).match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const defaults = getDefaultProfile();
    const normalized = normalizeProfile(parsed);
    const today = new Date().toISOString().split('T')[0];

    return {
      ...defaults,
      ...normalized,
      name: normalized.name || botUser.row.first_name || defaults.name,
      timezone: config.timezone,
      morningTime: defaults.morningTime,
      eveningTime: defaults.eveningTime,
      onboardingComplete: true,
      createdAt: today,
      lastReviewDate: today,
    };
  } catch (err) {
    console.error('[Companion] Failed to parse profile JSON:', err);
    return null;
  }
}

function stripProfileBlock(response: string): string {
  const markerIndex = response.indexOf(PROFILE_MARKER);
  if (markerIndex === -1) return response;
  return response.slice(0, markerIndex).trim();
}

function applySettingsUpdateIfPresent(
  response: string,
  botUser: BotUser
): { cleaned: string; applied: boolean; summary: string | null } {
  const markerIndex = response.indexOf(SETTINGS_MARKER);
  if (markerIndex === -1) return { cleaned: response, applied: false, summary: null };

  const blockSlice = response.slice(markerIndex);
  const jsonMatch = blockSlice.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    return { cleaned: response.slice(0, markerIndex).trim(), applied: false, summary: null };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[1]);
  } catch (err) {
    console.error('[Companion] Failed to parse settings update JSON:', err);
    return { cleaned: response.slice(0, markerIndex).trim(), applied: false, summary: null };
  }

  const current = getProfileForUser(botUser.row.id);
  if (!current) return { cleaned: response.slice(0, markerIndex).trim(), applied: false, summary: null };

  const normalized = normalizeProfile(parsed);
  const mergedSchedule = { ...current.schedule, ...(normalized.schedule ?? {}) };

  const updated: Profile = {
    ...current,
    ...normalized,
    schedule: mergedSchedule,
    morningTime:
      typeof parsed.morningTime === 'string' && /^\d{2}:\d{2}$/.test(parsed.morningTime)
        ? parsed.morningTime
        : current.morningTime,
    eveningTime:
      typeof parsed.eveningTime === 'string' && /^\d{2}:\d{2}$/.test(parsed.eveningTime)
        ? parsed.eveningTime
        : current.eveningTime,
    lastReviewDate: new Date().toISOString().split('T')[0],
    onboardingComplete: true,
  };

  saveProfileForUser(botUser.row.id, updated);

  const timeChanged =
    updated.morningTime !== current.morningTime || updated.eveningTime !== current.eveningTime;
  if (timeChanged) reloadScheduler();

  const changes: string[] = [];
  if (updated.name !== current.name) changes.push(`name → ${updated.name}`);
  if (updated.morningTime !== current.morningTime) changes.push(`morning → ${updated.morningTime}`);
  if (updated.eveningTime !== current.eveningTime) changes.push(`evening → ${updated.eveningTime}`);
  if (normalized.sections) changes.push(`sections updated`);
  if (normalized.schedule) changes.push(`schedule updated`);

  const summary = changes.length > 0 ? `⚙️ Updated: ${changes.join(', ')}` : null;

  return {
    cleaned: response.slice(0, markerIndex).trim(),
    applied: true,
    summary,
  };
}

async function completeOnboardingWithDefaults(
  ctx: Context,
  botUser: BotUser,
  response: string,
  sessionDate: Date
): Promise<void> {
  // AI compiled an entry but forgot the profile JSON. Save defaults so the user isn't
  // stranded — they can refine with natural-language settings or /settings later.
  const defaults = getDefaultProfile();
  defaults.timezone = config.timezone;
  defaults.name = botUser.row.first_name || defaults.name;
  defaults.onboardingComplete = true;
  defaults.createdAt = new Date().toISOString().split('T')[0];
  defaults.lastReviewDate = new Date().toISOString().split('T')[0];
  saveProfileForUser(botUser.row.id, defaults);
  reloadScheduler();

  const { reply, entry } = splitReplyAndEntry(response);
  if (reply) await ctx.reply(reply);

  if (entry) {
    const { dateStr, dayStr } = formatDateForJournal(sessionDate, defaults.timezone);
    saveJournalEntry({
      userId: botUser.row.id,
      entryDate: dateStr,
      dayOfWeek: dayStr,
      sessionType: 'evening',
      contentMarkdown: entry,
    });
    updateJournalState(String(botUser.row.telegram_id), { lastEveningDate: dateStr });
    await ctx.reply(entry);
  }

  await ctx.reply(
    `🌱 *You're set up, ${defaults.name}.* Using defaults for now — just tell me to change anything ("make my morning time 7am", "add reading as a section") and it'll stick.`,
    { parse_mode: 'Markdown' }
  );

  sessionStore.clear(String(botUser.row.telegram_id));
  console.log('[Companion] Onboarding completed via defaults-fallback for', botUser.row.telegram_id);
}

async function handleOnboardingCompletion(
  ctx: Context,
  botUser: BotUser,
  response: string,
  sessionDate: Date
): Promise<Stage> {
  const profile = extractProfileFromResponse(response, botUser);

  if (!profile) {
    // JSON was malformed or missing. Show the user what the AI said (minus the broken block)
    // and keep the session active so the AI can try again on the next turn.
    const cleaned = stripProfileBlock(response).trim();
    if (cleaned) await ctx.reply(cleaned);
    console.warn('[Companion] Onboarding response had PROFILE_COMPLETE marker but no valid JSON');
    return 'active';
  }

  const beforeProfile = stripProfileBlock(response);
  const { reply, entry } = splitReplyAndEntry(beforeProfile);

  if (reply) await ctx.reply(reply);

  saveProfileForUser(botUser.row.id, profile);
  reloadScheduler();

  if (entry) {
    const { dateStr, dayStr } = formatDateForJournal(sessionDate, profile.timezone);
    saveJournalEntry({
      userId: botUser.row.id,
      entryDate: dateStr,
      dayOfWeek: dayStr,
      sessionType: 'evening',
      contentMarkdown: entry,
    });
    updateJournalState(String(botUser.row.telegram_id), { lastEveningDate: dateStr });
    await ctx.reply(entry);
  }

  const sectionList = profile.sections.map((s) => `  ${s.emoji} ${s.title}`).join('\n');
  await ctx.reply(
    `🌱 *You're set up, ${profile.name}.*\n\n` +
      `I'll keep an ear out for these as we go:\n${sectionList}\n\n` +
      `You can journal anytime — just message me. I'll also check in around ${profile.morningTime} and ${profile.eveningTime}.\n\n` +
      `/settings to change anything.`,
    { parse_mode: 'Markdown' }
  );

  sessionStore.clear(String(botUser.row.telegram_id));
  console.log('[Companion] Onboarding completed for', botUser.row.telegram_id);
  return 'compiled';
}

export async function startCompanionSession(
  ctx: Context,
  telegramId: string,
  opts: StartOptions
): Promise<void> {
  const botUser = loadBotUser(telegramId);
  if (!botUser && opts.mode !== 'onboarding') {
    await ctx.reply("Let's set up your journal first — use /start.");
    return;
  }

  const now = opts.targetDate ?? new Date();
  const sessionType = sessionTypeFor(opts.mode);

  const state: ConversationState = {
    userId: telegramId,
    sessionType,
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: now,
    completed: false,
  };

  if (opts.continuation && botUser) {
    // Seed history so the AI treats the next user message as a continuation — no greeting,
    // no Claude call here. Just a light ready-signal in the chat and wait for their text.
    const ack = "I'm here.";
    state.conversationHistory.push(
      {
        role: 'user',
        content: '[system note] User just finished a journal entry and tapped "Keep going". Continue the thread naturally — do NOT greet, do NOT open a new topic. Respond to whatever they say next as if mid-conversation.',
      },
      {
        role: 'assistant',
        content: ack,
      }
    );
    sessionStore.set(telegramId, state);
    await ctx.reply(ack);
    return;
  }

  sessionStore.set(telegramId, state);

  if (opts.initialUserMessage) {
    await handleCompanionMessage(ctx, telegramId, opts.initialUserMessage);
    return;
  }

  const memory = botUser
    ? await loadMemoryFor(botUser, now)
    : { yesterdayEntry: null, weekSummary: null, streakDays: 0, daysSinceLastEntry: null, recentThemes: [] };

  const { cacheableCore, volatileContext } = await buildSystemFor(
    botUser,
    opts.mode,
    now,
    memory,
    opts.targetDate
  );

  try {
    const chatId = ctx.chat?.id ?? Number(telegramId);
    const greeting = await withTyping(ctx, chatId, () =>
      companionTurn({
        cacheableCore,
        volatileContext,
        conversationHistory: [],
        userMessage: '__begin__',
      })
    );

    state.conversationHistory.push(
      { role: 'user', content: '__begin__' },
      { role: 'assistant', content: greeting }
    );
    sessionStore.set(telegramId, state);

    const { reply } = splitReplyAndEntry(greeting);
    await ctx.reply(reply || greeting);
  } catch (error) {
    console.error('[Companion] Failed to start session:', error);
    sessionStore.clear(telegramId);
    await ctx.reply("Sorry, I hit a snag starting up. Try again in a moment.");
  }
}

export async function handleCompanionMessage(
  ctx: Context,
  telegramId: string,
  text: string
): Promise<void> {
  const state = sessionStore.get(telegramId);
  if (!state) return;

  const mode = resolveMode(state);
  const botUser = loadBotUser(telegramId);
  if (!botUser && mode !== 'onboarding') return;

  if (botUser && await handleImmediateAgentAction(ctx, botUser, text, state)) {
    return;
  }

  const memory = botUser
    ? await loadMemoryFor(botUser, state.startedAt)
    : { yesterdayEntry: null, weekSummary: null, streakDays: 0, daysSinceLastEntry: null, recentThemes: [] };

  const { cacheableCore, volatileContext } = await buildSystemFor(
    botUser,
    mode,
    state.startedAt,
    memory
  );

  state.conversationHistory.push({ role: 'user', content: text });
  sessionStore.set(telegramId, state);

  try {
    const chatId = ctx.chat?.id ?? Number(telegramId);
    const response = await withTyping(ctx, chatId, () =>
      companionTurn({
        cacheableCore,
        volatileContext,
        conversationHistory: state.conversationHistory.slice(0, -1),
        userMessage: text,
      })
    );

    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(telegramId, state);

    if (mode === 'onboarding' && botUser) {
      if (response.includes(PROFILE_MARKER)) {
        await handleOnboardingCompletion(ctx, botUser, response, state.startedAt);
        return;
      }
      // AI produced a compiled entry without the profile block — fall back to defaults
      // so we don't strand the user with an orphaned entry and no profile.
      if (detectEntry(response).found) {
        await completeOnboardingWithDefaults(ctx, botUser, response, state.startedAt);
        return;
      }
    }

    let working = response;
    if (botUser && working.includes(SETTINGS_MARKER)) {
      const result = applySettingsUpdateIfPresent(working, botUser);
      working = result.cleaned;
      if (result.applied && result.summary) {
        // Send the AI's natural ack first, then a quiet system confirmation.
        if (working) await ctx.reply(working);
        await ctx.reply(result.summary);
        return;
      }
    }

    const { reply, entry } = splitReplyAndEntry(working);

    if (entry && botUser) {
      if (reply) await ctx.reply(reply);
      await saveCompiledEntry(ctx, botUser, mode === 'vent' ? 'drop' : mode, entry, state.startedAt);
      state.completed = true;
      sessionStore.clear(telegramId);
      console.log('[Companion] Session completed for', telegramId, 'mode', mode);
      return;
    }

    // On drop/vent replies, give an explicit "Save & done" escape so the user isn't
    // dependent on natural ending cues — drops especially can hang otherwise.
    const showDropActions = mode === 'drop' || mode === 'vent';
    await ctx.reply(reply || working, showDropActions ? { reply_markup: { inline_keyboard: DROP_INLINE_ACTIONS } } : undefined);
  } catch (error) {
    console.error('[Companion] Error processing message:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
