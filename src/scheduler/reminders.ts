import { Telegraf } from 'telegraf';
import { getDueReminders, deleteReminder, PendingReminder } from '../db/reminders.repo';
import { getUserByTelegramId, listOnboardedUsers } from '../db/users.repo';
import { getProfileForUser } from '../db/profile.repo';
import { sessionStore, getJournalState, getTodayDateStringInZone } from '../state/session.store';
import { sendEveningPrompt, sendMorningPrompt } from '../bot/handlers/callback.handler';

const SWEEP_INTERVAL_MS = 30_000;

let intervalHandle: NodeJS.Timeout | null = null;

async function fireReminder(bot: Telegraf, reminder: PendingReminder): Promise<void> {
  const users = listOnboardedUsers();
  const userRow = users.find((u) => u.id === reminder.user_id);
  if (!userRow) {
    deleteReminder(reminder.id);
    return;
  }

  const profile = getProfileForUser(userRow.id);
  if (!profile) {
    deleteReminder(reminder.id);
    return;
  }

  const telegramId = userRow.telegram_id;

  // If a session is already active or today's slot is done, drop the reminder silently.
  if (sessionStore.has(telegramId)) {
    deleteReminder(reminder.id);
    return;
  }

  const today = getTodayDateStringInZone(profile.timezone);
  const state = getJournalState(telegramId);

  try {
    if (reminder.kind === 'evening_remind_later') {
      if (state.lastEveningDate !== today) {
        await sendEveningPrompt(bot, telegramId, {
          name: profile.name,
          missedYesterday: false,
        });
      }
    } else if (reminder.kind === 'morning_remind_later') {
      if (state.lastMorningDate !== today) {
        await sendMorningPrompt(bot, telegramId, profile.name);
      }
    }
  } catch (err) {
    console.error('[Reminders] fire failed:', err);
  } finally {
    deleteReminder(reminder.id);
  }
}

async function sweep(bot: Telegraf): Promise<void> {
  const due = getDueReminders(new Date());
  for (const reminder of due) {
    await fireReminder(bot, reminder);
  }
}

export function startReminderSweeper(bot: Telegraf): void {
  if (intervalHandle) return;
  // Fire missed-while-down reminders immediately on boot, then on a rolling interval.
  sweep(bot).catch((e) => console.error('[Reminders] boot sweep failed:', e));
  intervalHandle = setInterval(() => {
    sweep(bot).catch((e) => console.error('[Reminders] sweep failed:', e));
  }, SWEEP_INTERVAL_MS);
}

export function stopReminderSweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
