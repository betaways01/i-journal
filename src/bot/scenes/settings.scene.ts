import { Context } from 'telegraf';
import { sessionStore } from '../../state/session.store';
import { getProfileForUser, saveProfileForUser } from '../../db/profile.repo';
import { getUserByTelegramId } from '../../db/users.repo';
import { reloadScheduler } from '../../scheduler';
import { ConversationState } from '../../types';
import {
  formatAreas,
  formatProfileCard,
  parseAreaSections,
  parseName,
  parseTime,
  settingsMenuKeyboard,
  todayLocalDate,
} from './setup.helpers';
import { startWordOfDayProposal } from './routine.scene';

function settingsState(userId: string, step: string, data: Record<string, unknown> = {}): ConversationState {
  return {
    userId,
    sessionType: 'settings',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(),
    completed: false,
    flow: {
      name: 'settings',
      step,
      data,
    },
  };
}

function setStep(userId: string, step: string, data: Record<string, unknown> = {}): void {
  sessionStore.set(userId, settingsState(userId, step, data));
}

async function showSettingsMenu(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;
  const profile = getProfileForUser(userRow.id);
  if (!profile) {
    await ctx.reply("Let's set up your journal first - use /start.");
    return;
  }

  await ctx.reply(
    [
      'Settings',
      '',
      `Name: ${profile.name}`,
      `Morning: ${profile.morningTime}`,
      `Evening: ${profile.eveningTime}`,
      '',
      'Areas:',
      formatAreas(profile.sections),
    ].join('\n'),
    { reply_markup: { inline_keyboard: settingsMenuKeyboard() } }
  );
}

export async function startSettings(ctx: Context, userId: string): Promise<void> {
  setStep(userId, 'menu');
  await showSettingsMenu(ctx, userId);
}

export async function handleSettingsCallback(
  ctx: Context,
  userId: string,
  dataValue: string
): Promise<boolean> {
  if (!dataValue.startsWith('settings_')) return false;

  const userRow = getUserByTelegramId(userId);
  if (!userRow) return true;
  const profile = getProfileForUser(userRow.id);
  if (!profile) {
    await ctx.reply("Let's set up your journal first - use /start.");
    return true;
  }

  if (dataValue === 'settings_name') {
    setStep(userId, 'name');
    await ctx.reply('What should I call you?');
    return true;
  }

  if (dataValue === 'settings_areas') {
    setStep(userId, 'areas');
    await ctx.reply('Send the areas you want me to track, separated by commas.');
    return true;
  }

  if (dataValue === 'settings_morning') {
    setStep(userId, 'morning_time');
    await ctx.reply('What time should I send the morning check-in? Example: 06:30');
    return true;
  }

  if (dataValue === 'settings_evening') {
    setStep(userId, 'evening_time');
    await ctx.reply('What time should I send the evening journal prompt? Example: 21:30');
    return true;
  }

  if (dataValue === 'settings_word') {
    await startWordOfDayProposal(ctx, userId);
    return true;
  }

  if (dataValue === 'settings_done') {
    sessionStore.clear(userId);
    await ctx.reply(formatProfileCard(profile));
    return true;
  }

  return true;
}

export async function handleSettingsMessage(
  ctx: Context,
  userId: string,
  text: string
): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'settings') return;

  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  const profile = getProfileForUser(userRow.id);
  if (!profile) return;

  const step = state.flow?.step ?? 'menu';

  if (step === 'name') {
    const name = parseName(text);
    if (!name) {
      await ctx.reply('Send the name you want me to use.');
      return;
    }

    saveProfileForUser(userRow.id, {
      ...profile,
      name,
      lastReviewDate: todayLocalDate(profile.timezone),
      onboardingComplete: true,
    });
    setStep(userId, 'menu');
    await ctx.reply(`Name updated to ${name}.`);
    await showSettingsMenu(ctx, userId);
    return;
  }

  if (step === 'areas') {
    const sections = parseAreaSections(text);
    if (sections.length === 0) {
      await ctx.reply('List a few areas separated by commas, like: Work, Family, Faith, Personal.');
      return;
    }

    saveProfileForUser(userRow.id, {
      ...profile,
      sections,
      lastReviewDate: todayLocalDate(profile.timezone),
      onboardingComplete: true,
    });
    setStep(userId, 'menu');
    await ctx.reply('Areas updated.');
    await showSettingsMenu(ctx, userId);
    return;
  }

  if (step === 'morning_time' || step === 'evening_time') {
    const time = parseTime(text);
    if (!time) {
      await ctx.reply('Send a time like 06:30, 7am, or 21:30.');
      return;
    }

    const updated = {
      ...profile,
      morningTime: step === 'morning_time' ? time : profile.morningTime,
      eveningTime: step === 'evening_time' ? time : profile.eveningTime,
      lastReviewDate: todayLocalDate(profile.timezone),
      onboardingComplete: true,
    };
    saveProfileForUser(userRow.id, updated);
    reloadScheduler();
    setStep(userId, 'menu');
    await ctx.reply(`${step === 'morning_time' ? 'Morning' : 'Evening'} time updated to ${time}.`);
    await showSettingsMenu(ctx, userId);
    return;
  }

  await showSettingsMenu(ctx, userId);
}
