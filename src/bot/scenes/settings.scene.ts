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
  todayLocalDate,
} from './setup.helpers';
import { startAutomationCapture } from './automation.scene';
import { compactButtonLabel, formatRoutineSchedule } from '../../automation/labels';
import { formatLocalDateTime } from '../../automation/time';
import { listRoutinesForUser, updateRoutine } from '../../db/routines.repo';
import { deleteReminder, getReminderById, listRemindersForUser, PendingReminder } from '../../db/reminders.repo';
import { InlineKeyboardButton } from 'telegraf/types';

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

function reminderPayload(reminder: PendingReminder): Record<string, unknown> {
  if (!reminder.payload_json) return {};
  try {
    return JSON.parse(reminder.payload_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function reminderName(reminder: PendingReminder): string {
  const payload = reminderPayload(reminder);
  return typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : 'Reminder';
}

function reminderMessage(reminder: PendingReminder): string {
  const payload = reminderPayload(reminder);
  return typeof payload.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : 'Reminder';
}

function settingsMenuKeyboard(userDbId: number): InlineKeyboardButton[][] {
  const routines = listRoutinesForUser(userDbId).slice(0, 8);
  const reminders = listRemindersForUser(userDbId).slice(0, 8);
  const rows: InlineKeyboardButton[][] = [
    [
      { text: 'Name', callback_data: 'settings_name' },
      { text: 'Areas', callback_data: 'settings_areas' },
    ],
    [
      { text: 'Morning time', callback_data: 'settings_morning' },
      { text: 'Evening time', callback_data: 'settings_evening' },
    ],
  ];

  for (const routine of routines) {
    const prefix = routine.enabled === 1 ? 'Routine' : 'Paused';
    rows.push([
      {
        text: compactButtonLabel(`${prefix}: ${routine.name}`),
        callback_data: `settings_routine_${routine.id}`,
      },
    ]);
  }

  for (const reminder of reminders) {
    rows.push([
      {
        text: compactButtonLabel(`Reminder: ${reminderName(reminder)}`),
        callback_data: `settings_reminder_${reminder.id}`,
      },
    ]);
  }

  rows.push([{ text: 'Add automation', callback_data: 'settings_add_automation' }]);
  rows.push([{ text: 'Done', callback_data: 'settings_done' }]);
  return rows;
}

async function showSettingsMenu(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;
  const profile = getProfileForUser(userRow.id);
  if (!profile) {
    await ctx.reply("Let's set up your journal first - use /start.");
    return;
  }

  const routines = listRoutinesForUser(userRow.id);
  const reminders = listRemindersForUser(userRow.id);
  const automationLines = [
    ...routines.slice(0, 5).map((routine) => {
      const status = routine.enabled === 1 ? '' : ' (paused)';
      return `- ${routine.name}${status}: ${formatRoutineSchedule(routine.schedule)}`;
    }),
    ...reminders.slice(0, 5).map((reminder) => {
      const timezone = profile.timezone;
      return `- ${reminderName(reminder)}: ${formatLocalDateTime(new Date(reminder.fire_at), timezone)}`;
    }),
  ];

  await ctx.reply(
    [
      'Settings',
      '',
      `Name: ${profile.name}`,
      `Morning: ${profile.morningTime}`,
      `Evening: ${profile.eveningTime}`,
      '',
      profile.sections.length > 0
        ? `Areas:\n${formatAreas(profile.sections)}`
        : "Areas: none yet — I'll learn what matters as you write.",
      '',
      'Automations:',
      automationLines.length > 0 ? automationLines.join('\n') : 'None yet.',
    ].join('\n'),
    { reply_markup: { inline_keyboard: settingsMenuKeyboard(userRow.id) } }
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

  if (dataValue === 'settings_add_automation') {
    await startAutomationCapture(ctx, userId);
    return true;
  }

  const routineMatch = dataValue.match(/^settings_routine_(\d+)$/);
  if (routineMatch) {
    const routineId = Number.parseInt(routineMatch[1], 10);
    const routine = listRoutinesForUser(userRow.id).find((item) => item.id === routineId);
    if (!routine) {
      await ctx.reply('That routine was not found.');
      return true;
    }

    const prompt = typeof routine.config.prompt === 'string'
      ? routine.config.prompt
      : typeof routine.config.goal === 'string'
        ? routine.config.goal
        : 'No custom instruction stored.';
    await ctx.reply(
      [
        routine.name,
        '',
        `Status: ${routine.enabled === 1 ? 'Enabled' : 'Paused'}`,
        `Schedule: ${formatRoutineSchedule(routine.schedule)}`,
        `Instruction: ${prompt}`,
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: routine.enabled === 1 ? 'Pause' : 'Resume',
                callback_data: `settings_toggle_routine_${routine.id}`,
              },
            ],
            [{ text: 'Back', callback_data: 'settings_back' }],
          ],
        },
      }
    );
    return true;
  }

  const toggleRoutineMatch = dataValue.match(/^settings_toggle_routine_(\d+)$/);
  if (toggleRoutineMatch) {
    const routineId = Number.parseInt(toggleRoutineMatch[1], 10);
    const routine = listRoutinesForUser(userRow.id).find((item) => item.id === routineId);
    if (!routine) {
      await ctx.reply('That routine was not found.');
      return true;
    }
    const nextEnabled = routine.enabled !== 1;
    updateRoutine(routine.id, { enabled: nextEnabled });
    await ctx.reply(nextEnabled ? 'Routine resumed.' : 'Routine paused.');
    await showSettingsMenu(ctx, userId);
    return true;
  }

  const reminderMatch = dataValue.match(/^settings_reminder_(\d+)$/);
  if (reminderMatch) {
    const reminderId = Number.parseInt(reminderMatch[1], 10);
    const reminder = getReminderById(reminderId);
    if (!reminder || reminder.user_id !== userRow.id) {
      await ctx.reply('That reminder was not found.');
      return true;
    }

    await ctx.reply(
      [
        reminderName(reminder),
        '',
        `Time: ${formatLocalDateTime(new Date(reminder.fire_at), profile.timezone)}`,
        reminderMessage(reminder),
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Cancel reminder', callback_data: `settings_cancel_reminder_${reminder.id}` }],
            [{ text: 'Back', callback_data: 'settings_back' }],
          ],
        },
      }
    );
    return true;
  }

  const cancelReminderMatch = dataValue.match(/^settings_cancel_reminder_(\d+)$/);
  if (cancelReminderMatch) {
    const reminderId = Number.parseInt(cancelReminderMatch[1], 10);
    const reminder = getReminderById(reminderId);
    if (reminder && reminder.user_id === userRow.id) {
      deleteReminder(reminder.id);
      await ctx.reply('Reminder canceled.');
    } else {
      await ctx.reply('That reminder was not found.');
    }
    await showSettingsMenu(ctx, userId);
    return true;
  }

  if (dataValue === 'settings_back') {
    await showSettingsMenu(ctx, userId);
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
