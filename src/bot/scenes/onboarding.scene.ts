import { Context } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/types';
import { sessionStore } from '../../state/session.store';
import { getUserByTelegramId } from '../../db/users.repo';
import { saveProfileForUser } from '../../db/profile.repo';
import { getDefaultProfile, ProfileSection } from '../../profile/defaults';
import { config } from '../../config';
import { reloadScheduler } from '../../scheduler';
import { ConversationState } from '../../types';
import { QUICK_ACTIONS } from '../keyboards';
import {
  defaultAreaSections,
  formatAreas,
  formatProfileCard,
  makeProfile,
  parseAreaSections,
  parseName,
  parseTwoTimes,
  todayLocalDate,
} from './setup.helpers';

const DEFAULT_MORNING_TIME = '06:00';
const DEFAULT_EVENING_TIME = '21:00';

function onboardingState(userId: string, step: string, data: Record<string, unknown> = {}): ConversationState {
  return {
    userId,
    sessionType: 'onboarding',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(),
    completed: false,
    flow: {
      name: 'onboarding',
      step,
      data,
    },
  };
}

function areasKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: 'Use defaults', callback_data: 'onb_areas_defaults' }],
    [{ text: 'I will type my own', callback_data: 'onb_areas_type' }],
  ];
}

function timesKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: 'Use 06:00 + 21:00', callback_data: 'onb_times_defaults' }],
    [{ text: 'Set my own times', callback_data: 'onb_times_custom' }],
  ];
}

function confirmKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: 'Looks good - start journaling', callback_data: 'onb_confirm' }],
    [
      { text: 'Change name', callback_data: 'onb_change_name' },
      { text: 'Change areas', callback_data: 'onb_change_areas' },
    ],
    [{ text: 'Change times', callback_data: 'onb_change_times' }],
  ];
}

function getFlowData(userId: string): Record<string, unknown> {
  return sessionStore.get(userId)?.flow?.data ?? {};
}

function setStep(userId: string, step: string, data: Record<string, unknown>): void {
  sessionStore.set(userId, onboardingState(userId, step, data));
}

function readSections(data: Record<string, unknown>): ProfileSection[] {
  const sections = data.sections;
  return Array.isArray(sections) ? (sections as ProfileSection[]) : defaultAreaSections();
}

async function askName(ctx: Context): Promise<void> {
  await ctx.reply("Let's set up your journal properly.\n\nWhat should I call you?");
}

async function askAreas(ctx: Context, name: string): Promise<void> {
  await ctx.reply(
    `Got it, ${name}.\n\nWhat areas of life should I keep track of? You can list a few, like Work, Family, Faith, Personal.`,
    { reply_markup: { inline_keyboard: areasKeyboard() } }
  );
}

async function askTimes(ctx: Context): Promise<void> {
  await ctx.reply(
    'When should I check in?\n\nDefaults are morning at 06:00 and evening at 21:00.',
    { reply_markup: { inline_keyboard: timesKeyboard() } }
  );
}

async function askCustomTimes(ctx: Context): Promise<void> {
  await ctx.reply('Send both times in one message, like: 06:30 and 21:30');
}

async function showConfirmation(ctx: Context, data: Record<string, unknown>): Promise<void> {
  const name = typeof data.name === 'string' ? data.name : 'Friend';
  const sections = readSections(data);
  const morningTime = typeof data.morningTime === 'string' ? data.morningTime : DEFAULT_MORNING_TIME;
  const eveningTime = typeof data.eveningTime === 'string' ? data.eveningTime : DEFAULT_EVENING_TIME;

  await ctx.reply(
    [
      'Here is the setup:',
      '',
      `Name: ${name}`,
      'Areas:',
      formatAreas(sections),
      '',
      `Morning check-in: ${morningTime}`,
      `Evening journal: ${eveningTime}`,
    ].join('\n'),
    { reply_markup: { inline_keyboard: confirmKeyboard() } }
  );
}

async function completeOnboarding(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  const data = getFlowData(userId);
  const name = typeof data.name === 'string' ? data.name : userRow.first_name || 'Friend';
  const sections = readSections(data);
  const morningTime = typeof data.morningTime === 'string' ? data.morningTime : DEFAULT_MORNING_TIME;
  const eveningTime = typeof data.eveningTime === 'string' ? data.eveningTime : DEFAULT_EVENING_TIME;

  const profile = makeProfile({ name, sections, morningTime, eveningTime });
  saveProfileForUser(userRow.id, profile);
  reloadScheduler();
  sessionStore.clear(userId);

  await ctx.reply(formatProfileCard(profile), {
    reply_markup: { inline_keyboard: QUICK_ACTIONS },
  });
  await ctx.reply('You can also create small helpful routines later. Example: "Teach me a new word every morning."');
}

export async function startOnboarding(ctx: Context, userId: string): Promise<void> {
  sessionStore.set(userId, onboardingState(userId, 'name'));
  await askName(ctx);
}

export async function handleOnboardingMessage(ctx: Context, userId: string, text: string): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'onboarding') return;

  const step = state.flow?.step ?? 'name';
  const data = { ...(state.flow?.data ?? {}) };

  if (step === 'name') {
    const name = parseName(text);
    if (!name) {
      await ctx.reply('Send the name you want me to use.');
      return;
    }

    data.name = name;
    setStep(userId, 'areas', data);
    await askAreas(ctx, name);
    return;
  }

  if (step === 'areas') {
    const sections = parseAreaSections(text);
    if (sections.length === 0) {
      await ctx.reply('List a few areas separated by commas, like: Work, Family, Faith, Personal.');
      return;
    }

    data.sections = sections;
    setStep(userId, 'times', data);
    await askTimes(ctx);
    return;
  }

  if (step === 'times') {
    const parsed = parseTwoTimes(text);
    if (!parsed) {
      await ctx.reply('Use the buttons, or send both times like: 06:30 and 21:30');
      return;
    }

    data.morningTime = parsed.morningTime;
    data.eveningTime = parsed.eveningTime;
    setStep(userId, 'confirm', data);
    await showConfirmation(ctx, data);
    return;
  }

  if (step === 'times_custom') {
    const parsed = parseTwoTimes(text);
    if (!parsed) {
      await ctx.reply('I need two times. Try: 06:30 and 21:30');
      return;
    }

    data.morningTime = parsed.morningTime;
    data.eveningTime = parsed.eveningTime;
    setStep(userId, 'confirm', data);
    await showConfirmation(ctx, data);
    return;
  }

  if (step === 'confirm' && /^(yes|looks good|confirm|start)\b/i.test(text.trim())) {
    await completeOnboarding(ctx, userId);
    return;
  }

  await ctx.reply('Use the buttons above, or /skip to use defaults.');
}

export async function handleOnboardingCallback(
  ctx: Context,
  userId: string,
  dataValue: string
): Promise<boolean> {
  if (!dataValue.startsWith('onb_')) return false;

  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'onboarding') {
    await ctx.reply('Use /start to begin setup.');
    return true;
  }

  const data = { ...(state.flow?.data ?? {}) };

  if (dataValue === 'onb_areas_defaults') {
    data.sections = defaultAreaSections();
    setStep(userId, 'times', data);
    await askTimes(ctx);
    return true;
  }

  if (dataValue === 'onb_areas_type') {
    setStep(userId, 'areas', data);
    await ctx.reply('Type your areas separated by commas, like: Work, Family, Faith, Personal.');
    return true;
  }

  if (dataValue === 'onb_times_defaults') {
    data.morningTime = DEFAULT_MORNING_TIME;
    data.eveningTime = DEFAULT_EVENING_TIME;
    setStep(userId, 'confirm', data);
    await showConfirmation(ctx, data);
    return true;
  }

  if (dataValue === 'onb_times_custom') {
    setStep(userId, 'times_custom', data);
    await askCustomTimes(ctx);
    return true;
  }

  if (dataValue === 'onb_change_name') {
    setStep(userId, 'name', data);
    await askName(ctx);
    return true;
  }

  if (dataValue === 'onb_change_areas') {
    setStep(userId, 'areas', data);
    await ctx.reply('Type the areas again, separated by commas.');
    return true;
  }

  if (dataValue === 'onb_change_times') {
    setStep(userId, 'times_custom', data);
    await askCustomTimes(ctx);
    return true;
  }

  if (dataValue === 'onb_confirm') {
    await completeOnboarding(ctx, userId);
    return true;
  }

  return true;
}

export function skipOnboarding(userId: string): void {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  const defaults = getDefaultProfile();
  defaults.timezone = config.timezone;
  if (userRow.first_name) defaults.name = userRow.first_name;
  defaults.onboardingComplete = true;
  defaults.createdAt = todayLocalDate(config.timezone);
  defaults.lastReviewDate = defaults.createdAt;
  saveProfileForUser(userRow.id, defaults);
  sessionStore.clear(userId);
  reloadScheduler();
  console.log('[Onboarding] Skipped, default profile saved for', userId);
}
