import { Context } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { companionTurn, runCompanionAgent, withTyping } from '../../ai';
import {
  buildCompanionPrompt,
  CompanionMode,
  MemoryContext,
} from '../../ai/prompts/companion';
import { loadMemoryContext } from '../../ai/memory';
import { sessionStore } from '../../state/session.store';
import { ConversationState, SessionType } from '../../types';
import { loadBotUser, BotUser } from '../userContext';
import { getOneNoteStatusForUser } from '../../onenote/writer';
import {
  ensureAgentWorkspaceForUser,
  renderWorkspaceContext,
} from '../../agent/workspace';
import { buildCompanionTools, EntryMode, SavedEntryEffect } from '../../agent/tools';
import { POST_SAVE_ACTIONS, DROP_INLINE_ACTIONS } from '../keyboards';
import { oneNoteLinkHtml } from '../telegramHtml';

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

function modeEmoji(mode: EntryMode): string {
  switch (mode) {
    case 'morning': return '☀️';
    case 'evening': return '🌙';
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

/** vent and onboarding are persisted as casual "drop" entries. */
function entryModeFor(mode: CompanionMode): EntryMode {
  if (mode === 'morning') return 'morning';
  if (mode === 'evening') return 'evening';
  return 'drop';
}

function buildSaveConfirmation(saved: SavedEntryEffect): string {
  const parts = [`${modeEmoji(saved.mode)} Saved ✓`];

  if (saved.streakDays >= 3) {
    const flame = saved.streakDays >= 7 ? ' 🔥' : '';
    parts.push(` — ${saved.streakDays} days in a row${flame}`);
  } else if (saved.streakDays === 2) {
    parts.push(' — day 2 ✨');
  }

  let msg = parts.join('');

  if (saved.oneNoteStatus === 'synced' && saved.oneNoteUrl) {
    msg += `\n${oneNoteLinkHtml(saved.oneNoteUrl)}`;
  } else if (saved.oneNoteStatus === 'failed') {
    msg += `\n<i>couldn't reach OneNote this time — your entry is safe locally. /storage to reconnect.</i>`;
  }

  return msg;
}

async function reactToUserMessage(ctx: Context, emoji: string): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    const messageId = (ctx.message as { message_id?: number })?.message_id;
    if (!chatId || !messageId) return;

    await (ctx.telegram as unknown as {
      callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
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
  const onboarding = mode === 'onboarding';

  const storageSummary = onboarding
    ? 'Setup is not finished yet. Once it is, entries save first to the private SQLite database; OneNote is an optional backup.'
    : botUser
      ? getOneNoteStatusForUser(botUser.row).connected
        ? 'Entries save first to the private SQLite database. OneNote backup/sync is connected for this account.'
        : 'Entries save first to the private SQLite database. OneNote backup is optional and not connected for this account.'
      : 'During setup, no journal entries are saved yet. After setup, entries save first to the private SQLite database.';

  const workspaceContext = botUser
    ? (ensureAgentWorkspaceForUser(botUser.row),
      renderWorkspaceContext(botUser.row.id, { includeBootstrap: onboarding }))
    : undefined;

  const { cacheableCore, volatileContext } = buildCompanionPrompt({
    // During first-meeting onboarding, present "nothing set up yet" (no default profile areas).
    profile: onboarding ? null : (botUser?.profile ?? null),
    mode,
    now,
    memory,
    catchUpDate,
    storageSummary,
    workspaceContext,
    firstNameHint: onboarding ? botUser?.row.first_name ?? undefined : undefined,
  });
  return { cacheableCore, volatileContext };
}

function toAnthropicMessages(history: ConversationState['conversationHistory']): Anthropic.MessageParam[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

const AGENT_REPLY_FALLBACK = "I'm here — say more whenever you're ready.";

// The agent often mentions URLs (OneNote, a link it found). Telegram otherwise renders an ugly
// auto-preview card (e.g. the "Microsoft OneNote Online — sign in" box). Disable it everywhere
// the companion speaks; the only intentional link is the tappable "Open in OneNote" anchor.
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

async function presentSavedEntry(
  ctx: Context,
  saved: SavedEntryEffect,
  closingLine: string
): Promise<void> {
  // 1) The journal entry, in the user's own voice. Sent as plaintext (Telegram legacy
  // Markdown ignores "##" headings and 400s on unbalanced * _), so strip the leading
  // heading line — the mode is already shown in the save confirmation below.
  const body = saved.markdown.replace(/^\s*#{1,6}\s.*(?:\r?\n)+/, '').trim() || saved.markdown.trim();
  await ctx.reply(body, NO_PREVIEW);
  void reactToUserMessage(ctx, saved.mode === 'morning' ? '☀' : saved.mode === 'evening' ? '🌙' : '✍');

  // 2) A short warm closing line from the companion (if it added one).
  if (closingLine && closingLine.trim()) {
    await ctx.reply(closingLine.trim(), NO_PREVIEW);
  }

  // 3) The save confirmation + quick actions. HTML so "Open in OneNote" can be an onenote:
  // app link; preview disabled so it doesn't render as an ugly "OneDrive sign-in" card.
  await ctx.reply(buildSaveConfirmation(saved), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: POST_SAVE_ACTIONS },
  });
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
    // no Claude call here. Just a light ready-signal and wait for their text.
    const ack = "I'm here.";
    state.conversationHistory.push(
      {
        role: 'user',
        content:
          '[system note] User just finished a journal entry and tapped "Keep going". Continue the thread naturally — do NOT greet, do NOT open a new topic. Respond to whatever they say next as if mid-conversation.',
      },
      { role: 'assistant', content: ack }
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
    const rawGreeting = await withTyping(ctx, chatId, () =>
      companionTurn({
        cacheableCore,
        volatileContext,
        conversationHistory: [],
        userMessage: '__begin__',
      })
    );
    // Never persist empty/whitespace assistant content — it would 400 the next turn and
    // brick the session (same invariant as the main turn and continuation seed).
    const greeting = rawGreeting.trim() || AGENT_REPLY_FALLBACK;

    state.conversationHistory.push(
      { role: 'user', content: '__begin__' },
      { role: 'assistant', content: greeting }
    );
    sessionStore.set(telegramId, state);

    await ctx.reply(greeting, NO_PREVIEW);
  } catch (error) {
    console.error('[Companion] Failed to start session:', error);
    sessionStore.clear(telegramId);
    await ctx.reply('Sorry, I hit a snag starting up. Try again in a moment.');
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
  if (!botUser) return;

  const onboarding = mode === 'onboarding';
  // Defensive: a session created under the OLD deterministic bootstrap may carry a stale `flow`.
  // The agent path ignores it; drop it so legacy state can't linger after this deploy.
  if (onboarding && state.flow) state.flow = undefined;
  const entryMode = entryModeFor(mode);

  const memory = await loadMemoryFor(botUser, state.startedAt);
  const { cacheableCore, volatileContext } = await buildSystemFor(botUser, mode, state.startedAt, memory);

  state.conversationHistory.push({ role: 'user', content: text });
  sessionStore.set(telegramId, state);

  const { tools, effects } = buildCompanionTools({
    botUser,
    sessionMode: entryMode,
    sessionDate: state.startedAt,
    isOnboarding: onboarding,
  });

  try {
    const chatId = ctx.chat?.id ?? Number(telegramId);
    const result = await withTyping(ctx, chatId, () =>
      runCompanionAgent({
        cacheableCore,
        volatileContext,
        messages: toAnthropicMessages(state.conversationHistory),
        tools,
        onToolUse: (name) => console.log(`[Companion] ${telegramId} tool: ${name}`),
      })
    );

    // Persist only the final text reply in history — the within-turn tool calls are ephemeral.
    // Never store empty assistant content: an empty turn would 400 the API on the next message
    // and brick the session for its whole TTL.
    const closing = result.text.trim();
    const reply = closing || AGENT_REPLY_FALLBACK;
    state.conversationHistory.push({ role: 'assistant', content: reply });

    // First-meeting onboarding just finished → flip the session to a normal drop so the
    // conversation keeps flowing with the full toolset (no separate "setup complete" card).
    if (effects.onboardingCompleted) {
      state.sessionType = 'drop';
      console.log('[Companion] Onboarding completed via complete_setup for', telegramId);
    }
    sessionStore.set(telegramId, state);

    if (effects.savedEntry) {
      await presentSavedEntry(ctx, effects.savedEntry, closing);
      state.completed = true;
      sessionStore.clear(telegramId);
      console.log('[Companion] Session completed for', telegramId, 'mode', mode);
      return;
    }

    // Only offer the drop "Save & done / Cancel" shortcut once a real thread has built up —
    // never during onboarding, and never on the opening exchange (it was appearing on simple
    // questions like "you are?").
    const showDropActions =
      !onboarding && entryMode === 'drop' && state.conversationHistory.length >= 6;
    await ctx.reply(
      reply,
      showDropActions
        ? { ...NO_PREVIEW, reply_markup: { inline_keyboard: DROP_INLINE_ACTIONS } }
        : NO_PREVIEW
    );
  } catch (error) {
    console.error('[Companion] Error processing message:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
