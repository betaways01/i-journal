import { Context } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/types';
import { withTyping } from '../../ai';
import { sessionStore } from '../../state/session.store';
import { getUserByTelegramId } from '../../db/users.repo';
import { saveProfileForUser } from '../../db/profile.repo';
import { getDefaultProfile } from '../../profile/defaults';
import { config } from '../../config';
import { reloadScheduler } from '../../scheduler';
import { ConversationState } from '../../types';
import { QUICK_ACTIONS } from '../keyboards';
import {
  defaultAreaSections,
  formatAreas,
  formatProfileCard,
  makeProfile,
  todayLocalDate,
} from './setup.helpers';
import {
  emptyBootstrapDraft,
  ensureAgentWorkspaceForUser,
  hasEnoughForBootstrap,
  preferredName,
  renderWorkspaceContext,
  saveWorkspaceAfterBootstrap,
} from '../../agent/workspace';
import {
  mergeBootstrapPatch,
  understandBootstrapTurn,
} from '../../agent/bootstrap';
import { BootstrapDraft } from '../../agent/types';
import {
  createRoutine,
  findRoutineForUserByKind,
  updateRoutine,
} from '../../db/routines.repo';
import { computeNextRunAt } from '../../routines/schedule';
import { DailyRoutineSchedule } from '../../routines/types';

const DEFAULT_MORNING_TIME = '06:00';
const DEFAULT_EVENING_TIME = '21:00';

function confirmKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: 'Looks right - start journaling', callback_data: 'onb_confirm' }],
    [{ text: 'Keep adjusting', callback_data: 'onb_keep_talking' }],
    [{ text: 'Use simple defaults', callback_data: 'onb_defaults' }],
  ];
}

function onboardingState(
  userId: string,
  data: { draft: BootstrapDraft; awaitingFinalConfirm?: boolean; history?: ConversationState['conversationHistory'] }
): ConversationState {
  return {
    userId,
    sessionType: 'onboarding',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: data.history ?? [],
    startedAt: new Date(),
    completed: false,
    flow: {
      name: 'onboarding',
      step: data.awaitingFinalConfirm ? 'final_confirm' : 'bootstrap',
      data: {
        draft: data.draft,
        awaitingFinalConfirm: data.awaitingFinalConfirm ?? false,
      },
    },
  };
}

function readDraft(state: ConversationState | undefined): BootstrapDraft {
  const raw = state?.flow?.data?.draft;
  if (!raw || typeof raw !== 'object') return emptyBootstrapDraft();
  const draft = raw as BootstrapDraft;
  return {
    ...emptyBootstrapDraft(),
    ...draft,
    userIdentity: {
      ...emptyBootstrapDraft().userIdentity,
      ...(draft.userIdentity ?? {}),
      nicknames: draft.userIdentity?.nicknames ?? [],
      aliases: draft.userIdentity?.aliases ?? [],
      rawMentions: draft.userIdentity?.rawMentions ?? [],
    },
    agentIdentity: draft.agentIdentity ?? {},
    areas: Array.isArray(draft.areas) ? draft.areas : [],
    routineProposals: Array.isArray(draft.routineProposals) ? draft.routineProposals : [],
    notes: Array.isArray(draft.notes) ? draft.notes : [],
  };
}

function setBootstrapState(
  userId: string,
  draft: BootstrapDraft,
  opts: { awaitingFinalConfirm?: boolean; history?: ConversationState['conversationHistory'] } = {}
): void {
  sessionStore.set(userId, onboardingState(userId, { draft, ...opts }));
}

function finalSummary(draft: BootstrapDraft): string {
  const name = preferredName(draft.userIdentity);
  const areas = draft.areas.length > 0 ? draft.areas : defaultAreaSections();
  const morningTime = draft.morningTime ?? DEFAULT_MORNING_TIME;
  const eveningTime = draft.eveningTime ?? DEFAULT_EVENING_TIME;
  const nicknames = draft.userIdentity.nicknames.length
    ? `\nNicknames: ${draft.userIdentity.nicknames.join(', ')}`
    : '';
  const aliases = draft.userIdentity.aliases.length
    ? `\nOther names/aliases: ${draft.userIdentity.aliases.join(', ')}`
    : '';
  const agentName = draft.agentIdentity.name ? `\nCompanion name: ${draft.agentIdentity.name}` : '';
  const routines = draft.routineProposals.length > 0
    ? [
        '',
        'Routines I can set up:',
        ...draft.routineProposals.map((r) => `- ${r.name}${r.time ? ` at ${r.time}` : ''}`),
      ].join('\n')
    : '';

  return [
    'Here is what I understand so far:',
    '',
    `I should call you: ${name}${nicknames}${aliases}${agentName}`,
    '',
    'Life areas:',
    formatAreas(areas),
    '',
    `Morning check-in: ${morningTime}`,
    `Evening journal: ${eveningTime}`,
    routines,
  ].join('\n');
}

async function showFinalConfirmation(ctx: Context, userId: string, draft: BootstrapDraft): Promise<void> {
  setBootstrapState(userId, draft, { awaitingFinalConfirm: true, history: sessionStore.get(userId)?.conversationHistory });
  await ctx.reply(finalSummary(draft), {
    reply_markup: { inline_keyboard: confirmKeyboard() },
  });
}

function draftToProfile(draft: BootstrapDraft) {
  return makeProfile({
    name: preferredName(draft.userIdentity),
    sections: draft.areas.length > 0 ? draft.areas : defaultAreaSections(),
    morningTime: draft.morningTime ?? DEFAULT_MORNING_TIME,
    eveningTime: draft.eveningTime ?? DEFAULT_EVENING_TIME,
  });
}

function upsertBootstrapRoutines(userId: number, draft: BootstrapDraft, timezone: string): void {
  for (const proposal of draft.routineProposals) {
    const time = proposal.time ?? draft.morningTime ?? DEFAULT_MORNING_TIME;
    const schedule: DailyRoutineSchedule = {
      type: 'daily',
      time,
      timezone,
    };
    const nextRunAt = computeNextRunAt(schedule, new Date());
    const config = {
      goal: proposal.goal,
      prompt: proposal.prompt,
    };
    const existing = findRoutineForUserByKind(userId, proposal.kind);
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
        userId,
        kind: proposal.kind,
        name: proposal.name,
        schedule,
        config,
        nextRunAt,
      });
    }
  }
}

async function completeOnboarding(ctx: Context, userId: string, draft: BootstrapDraft): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  const profile = draftToProfile(draft);
  saveProfileForUser(userRow.id, profile);
  saveWorkspaceAfterBootstrap(userRow.id, draft, profile);
  upsertBootstrapRoutines(userRow.id, draft, profile.timezone);
  reloadScheduler();
  sessionStore.clear(userId);

  await ctx.reply(formatProfileCard(profile), {
    reply_markup: { inline_keyboard: QUICK_ACTIONS },
  });
  await ctx.reply('From here, you can speak naturally. If you want a recurring thing, just say it like a normal request.');
}

export async function startOnboarding(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (userRow) ensureAgentWorkspaceForUser(userRow);
  const draft = emptyBootstrapDraft();
  setBootstrapState(userId, draft);

  await ctx.reply(
    "Let's set this up in a more human way.\n\nTell me what I should call you. You can mention nicknames, another name you use, or even what you'd like to call this companion."
  );
}

export async function handleOnboardingMessage(ctx: Context, userId: string, text: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;
  ensureAgentWorkspaceForUser(userRow);

  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'onboarding') return;

  const draft = readDraft(state);
  const awaitingFinalConfirm = state.flow?.step === 'final_confirm';
  const lowered = text.trim().toLowerCase();

  if (awaitingFinalConfirm && /^(yes|yep|correct|looks right|looks good|confirm|start)\b/i.test(lowered)) {
    await completeOnboarding(ctx, userId, draft);
    return;
  }

  if (awaitingFinalConfirm && /^(no|change|adjust|not quite|wait)\b/i.test(lowered)) {
    setBootstrapState(userId, draft, { history: state.conversationHistory });
    await ctx.reply('No problem. Tell me what to change in your own words.');
    return;
  }

  const history = [...state.conversationHistory, { role: 'user' as const, content: text }];
  setBootstrapState(userId, draft, { history });

  try {
    const chatId = ctx.chat?.id ?? Number(userId);
    const workspaceContext = renderWorkspaceContext(userRow.id, { includeBootstrap: true });
    const result = await withTyping(ctx, chatId, () =>
      understandBootstrapTurn({
        workspaceContext,
        draft,
        history: state.conversationHistory,
        userMessage: text,
      })
    );

    const merged = mergeBootstrapPatch(draft, result.patch, text);
    const assistantReply = result.assistantReply;
    const nextHistory = [...history, { role: 'assistant' as const, content: assistantReply }];
    setBootstrapState(userId, merged, { history: nextHistory });

    await ctx.reply(assistantReply);

    const enough = hasEnoughForBootstrap(merged);
    if (enough && (result.readyToComplete || result.missing.length === 0)) {
      await showFinalConfirmation(ctx, userId, merged);
      return;
    }
  } catch (error) {
    console.error('[Onboarding] bootstrap understanding failed:', error);
    await ctx.reply("I hit a snag understanding that. Say it again naturally; I'll catch up.");
  }
}

export async function handleOnboardingCallback(
  ctx: Context,
  userId: string,
  dataValue: string
): Promise<boolean> {
  if (!dataValue.startsWith('onb_')) return false;

  const userRow = getUserByTelegramId(userId);
  if (!userRow) return true;
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'onboarding') {
    await ctx.reply('Use /start to begin setup.');
    return true;
  }

  const draft = readDraft(state);

  if (dataValue === 'onb_confirm') {
    await completeOnboarding(ctx, userId, draft);
    return true;
  }

  if (dataValue === 'onb_keep_talking') {
    setBootstrapState(userId, draft, { history: state.conversationHistory });
    await ctx.reply('Tell me what to change or add. No special format needed.');
    return true;
  }

  if (dataValue === 'onb_defaults') {
    const withDefaults: BootstrapDraft = {
      ...draft,
      userIdentity: {
        ...draft.userIdentity,
        preferredName: draft.userIdentity.preferredName || userRow.first_name || 'Friend',
      },
      areas: draft.areas.length > 0 ? draft.areas : defaultAreaSections(),
      morningTime: draft.morningTime ?? DEFAULT_MORNING_TIME,
      eveningTime: draft.eveningTime ?? DEFAULT_EVENING_TIME,
    };
    await showFinalConfirmation(ctx, userId, withDefaults);
    return true;
  }

  return true;
}

export function skipOnboarding(userId: string): void {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  ensureAgentWorkspaceForUser(userRow);
  const defaults = getDefaultProfile();
  defaults.timezone = config.timezone;
  if (userRow.first_name) defaults.name = userRow.first_name;
  defaults.onboardingComplete = true;
  defaults.createdAt = todayLocalDate(config.timezone);
  defaults.lastReviewDate = defaults.createdAt;
  saveProfileForUser(userRow.id, defaults);
  reloadScheduler();
  sessionStore.clear(userId);
  console.log('[Onboarding] Skipped, default profile saved for', userId);
}
