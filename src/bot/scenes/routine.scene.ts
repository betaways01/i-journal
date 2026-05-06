import { Context } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/types';
import { sessionStore } from '../../state/session.store';
import { getUserByTelegramId, UserRow } from '../../db/users.repo';
import {
  createRoutine,
  findRoutineForUserByKind,
  updateRoutine,
} from '../../db/routines.repo';
import { getProfileForUser } from '../../db/profile.repo';
import { ConversationState } from '../../types';
import { computeNextRunAt } from '../../routines/schedule';
import { DailyRoutineSchedule, RoutineKind } from '../../routines/types';
import { parseTime } from './setup.helpers';

interface WordRoutineProposal {
  kind: RoutineKind;
  name: string;
  time: string;
  timezone: string;
  goal: string;
}

function routineState(userId: string, step: string, data: Record<string, unknown>): ConversationState {
  return {
    userId,
    sessionType: 'routine_setup',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(),
    completed: false,
    flow: {
      name: 'routine_setup',
      step,
      data,
    },
  };
}

function setStep(userId: string, step: string, data: Record<string, unknown>): void {
  sessionStore.set(userId, routineState(userId, step, data));
}

function proposalKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: 'Confirm', callback_data: 'routine_confirm' },
      { text: 'Change time', callback_data: 'routine_change_time' },
    ],
    [{ text: 'Cancel', callback_data: 'routine_cancel' }],
  ];
}

function proposalFromState(userId: string): WordRoutineProposal | null {
  const data = sessionStore.get(userId)?.flow?.data ?? {};
  const raw = data.proposal;
  if (!raw || typeof raw !== 'object') return null;
  return raw as WordRoutineProposal;
}

function isWordRoutineInstruction(text: string): boolean {
  const lower = text.toLowerCase();
  const asksForWord = /\b(word|vocabulary|vocab|phrase)\b/.test(lower);
  const asksForLearning = /\b(teach|learn|improve|send|give)\b/.test(lower);
  const recurring = /\b(every|daily|morning|each day|per day)\b/.test(lower);
  return asksForWord && asksForLearning && recurring;
}

function extractRequestedTime(text: string): string | null {
  const atMatch = text.match(/\bat\s+([^,.]+)/i);
  if (atMatch) {
    const parsed = parseTime(atMatch[1]);
    if (parsed) return parsed;
  }
  return parseTime(text);
}

function buildWordProposal(userRow: UserRow, text: string): WordRoutineProposal | null {
  const profile = getProfileForUser(userRow.id);
  if (!profile || !isWordRoutineInstruction(text)) return null;

  return {
    kind: 'learning.word_of_day',
    name: 'Daily conversation word',
    time: extractRequestedTime(text) ?? profile.morningTime,
    timezone: profile.timezone,
    goal: 'improve daily conversations',
  };
}

async function showProposal(ctx: Context, proposal: WordRoutineProposal): Promise<void> {
  await ctx.reply(
    [
      'I can set this up:',
      '',
      proposal.name,
      `Time: ${proposal.time} (${proposal.timezone})`,
      'What you get: one useful conversation word, a simple meaning, and one example sentence.',
      '',
      'I will only save this routine if you confirm.',
    ].join('\n'),
    { reply_markup: { inline_keyboard: proposalKeyboard() } }
  );
}

export async function maybeStartRoutineFromText(
  ctx: Context,
  userRow: UserRow,
  text: string
): Promise<boolean> {
  const proposal = buildWordProposal(userRow, text);
  if (!proposal) return false;

  setStep(userRow.telegram_id, 'confirm', { proposal });
  await showProposal(ctx, proposal);
  return true;
}

export async function startWordOfDayProposal(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;
  const profile = getProfileForUser(userRow.id);
  if (!profile) {
    await ctx.reply("Let's set up your journal first - use /start.");
    return;
  }

  const proposal: WordRoutineProposal = {
    kind: 'learning.word_of_day',
    name: 'Daily conversation word',
    time: profile.morningTime,
    timezone: profile.timezone,
    goal: 'improve daily conversations',
  };

  setStep(userId, 'confirm', { proposal });
  await showProposal(ctx, proposal);
}

async function confirmRoutine(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  const proposal = proposalFromState(userId);
  if (!userRow || !proposal) {
    await ctx.reply('No routine proposal is active.');
    return;
  }

  const schedule: DailyRoutineSchedule = {
    type: 'daily',
    time: proposal.time,
    timezone: proposal.timezone,
  };
  const nextRunAt = computeNextRunAt(schedule, new Date());
  const config = { goal: proposal.goal };
  const existing = findRoutineForUserByKind(userRow.id, proposal.kind);

  if (existing) {
    updateRoutine(existing.id, {
      name: proposal.name,
      enabled: true,
      schedule,
      config: { ...existing.config, ...config },
      nextRunAt,
    });
  } else {
    createRoutine({
      userId: userRow.id,
      kind: proposal.kind,
      name: proposal.name,
      schedule,
      config,
      nextRunAt,
    });
  }

  sessionStore.clear(userId);
  await ctx.reply(
    [
      'Routine saved.',
      '',
      `${proposal.name} will run daily at ${proposal.time} (${proposal.timezone}).`,
      `Next run: ${nextRunAt.toLocaleString('en-US', { timeZone: proposal.timezone })}`,
    ].join('\n')
  );
}

export async function handleRoutineSetupMessage(
  ctx: Context,
  userId: string,
  text: string
): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'routine_setup') return;

  const proposal = proposalFromState(userId);
  if (!proposal) {
    sessionStore.clear(userId);
    await ctx.reply('Routine setup expired. Tell me again what you want to set up.');
    return;
  }

  if (state.flow?.step === 'change_time') {
    const time = parseTime(text);
    if (!time) {
      await ctx.reply('Send a time like 06:30, 7am, or 21:30.');
      return;
    }

    const updated: WordRoutineProposal = { ...proposal, time };
    setStep(userId, 'confirm', { proposal: updated });
    await showProposal(ctx, updated);
    return;
  }

  await ctx.reply('Use the buttons above to confirm, change time, or cancel.');
}

export async function handleRoutineSetupCallback(
  ctx: Context,
  userId: string,
  dataValue: string
): Promise<boolean> {
  if (!dataValue.startsWith('routine_')) return false;

  if (dataValue === 'routine_word_default') {
    await startWordOfDayProposal(ctx, userId);
    return true;
  }

  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'routine_setup') {
    await ctx.reply('No routine setup is active.');
    return true;
  }

  if (dataValue === 'routine_confirm') {
    await confirmRoutine(ctx, userId);
    return true;
  }

  if (dataValue === 'routine_change_time') {
    const proposal = proposalFromState(userId);
    if (!proposal) return true;
    setStep(userId, 'change_time', { proposal });
    await ctx.reply('What time should this run each day? Example: 06:30');
    return true;
  }

  if (dataValue === 'routine_cancel') {
    sessionStore.clear(userId);
    await ctx.reply('Routine canceled.');
    return true;
  }

  return true;
}
