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
import { POST_SAVE_ACTIONS } from '../keyboards';

const PROFILE_MARKER = '[PROFILE_COMPLETE]';
const SETTINGS_MARKER = '[SETTINGS_UPDATE]';

type Stage = 'active' | 'compiled';

const ENTRY_HEADING_RE = /^##\s*[^\n]*(Morning|Evening|Drop)\s*$/m;

interface StartOptions {
  mode: CompanionMode;
  targetDate?: Date;
  initialUserMessage?: string;
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

function computeStreakDays(userId: number, timezone: string): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const start = thirtyDaysAgo.toLocaleDateString('en-CA', { timeZone: timezone });

  const entries = getEntriesInDateRange(userId, start, today);
  const distinctDates = new Set(entries.map((e) => e.entry_date));

  let streak = 0;
  const cursor = new Date();
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
  const { cacheableCore, volatileContext } = buildCompanionPrompt({
    profile: botUser?.profile ?? null,
    mode,
    now,
    memory,
    catchUpDate,
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
  const sessionTypeForSave: 'morning' | 'evening' = mode === 'morning' ? 'morning' : 'evening';
  const { dateStr, dayStr } = formatDateForJournal(sessionDate, botUser.profile.timezone);

  const entryId = saveJournalEntry({
    userId: botUser.row.id,
    entryDate: dateStr,
    dayOfWeek: dayStr,
    sessionType: sessionTypeForSave,
    contentMarkdown: entryMarkdown,
  });

  if (mode === 'morning') {
    updateJournalState(String(botUser.row.telegram_id), { lastMorningDate: dateStr });
  } else if (mode === 'evening') {
    updateJournalState(String(botUser.row.telegram_id), { lastEveningDate: dateStr });
  }

  const streakDays = computeStreakDays(botUser.row.id, botUser.profile.timezone);

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

async function handleOnboardingCompletion(
  ctx: Context,
  botUser: BotUser,
  response: string,
  sessionDate: Date
): Promise<Stage> {
  const profile = extractProfileFromResponse(response, botUser);
  if (!profile) return 'active';

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

    if (mode === 'onboarding' && response.includes(PROFILE_MARKER) && botUser) {
      await handleOnboardingCompletion(ctx, botUser, response, state.startedAt);
      return;
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

    await ctx.reply(reply || working);
  } catch (error) {
    console.error('[Companion] Error processing message:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
