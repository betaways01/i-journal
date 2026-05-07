import cron, { ScheduledTask } from 'node-cron';
import { Telegraf } from 'telegraf';
import { listOnboardedUsers } from '../db/users.repo';
import { getProfileForUser, needsReviewForUser } from '../db/profile.repo';
import {
  sessionStore,
  getJournalState,
  getTodayDateStringInZone,
  getYesterdayDateStringInZone,
} from '../state/session.store';
import { clearStaleSessions } from '../db/sessions.repo';
import { sendMorningPrompt, sendEveningPrompt } from '../bot/handlers/callback.handler';

let botRef: Telegraf | null = null;
const activeTasks: ScheduledTask[] = [];

function timeToCron(time: string): string {
  const [hour, minute] = time.split(':');
  return `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;
}

async function triggerMorningForUser(bot: Telegraf, telegramId: string): Promise<void> {
  console.log(`[Scheduler] Morning trigger for ${telegramId}`);

  clearStaleSessions();

  const users = listOnboardedUsers();
  const userRow = users.find((u) => u.telegram_id === telegramId);
  if (!userRow) return;

  const profile = getProfileForUser(userRow.id);
  if (!profile) return;

  const state = getJournalState(telegramId);
  const today = getTodayDateStringInZone(profile.timezone);
  if (state.lastMorningDate === today) {
    console.log(`[Scheduler] Morning already done for ${telegramId}`);
    return;
  }

  if (sessionStore.has(telegramId)) {
    console.log(`[Scheduler] Session active for ${telegramId} — skipping morning trigger`);
    return;
  }

  await sendMorningPrompt(bot, telegramId, profile.name);
}

async function triggerEveningForUser(bot: Telegraf, telegramId: string): Promise<void> {
  console.log(`[Scheduler] Evening trigger for ${telegramId}`);

  clearStaleSessions();

  const users = listOnboardedUsers();
  const userRow = users.find((u) => u.telegram_id === telegramId);
  if (!userRow) return;

  const profile = getProfileForUser(userRow.id);
  if (!profile) return;

  const today = getTodayDateStringInZone(profile.timezone);
  const yesterday = getYesterdayDateStringInZone(profile.timezone);
  const state = getJournalState(telegramId);

  if (state.lastEveningDate === today) {
    console.log(`[Scheduler] Evening already done for ${telegramId}`);
    return;
  }

  if (sessionStore.has(telegramId)) {
    console.log(`[Scheduler] Session active for ${telegramId} — skipping evening trigger`);
    return;
  }

  // Missed-yesterday nudge — button menu, no auto-start
  if (state.lastEveningDate !== yesterday && state.lastEveningDate !== null) {
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const dayName = yesterdayDate.toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: profile.timezone,
    });

    await sendEveningPrompt(bot, telegramId, {
      name: profile.name,
      missedYesterday: true,
      missedDayName: dayName,
    });
    return;
  }

  if (needsReviewForUser(userRow.id)) {
    await bot.telegram.sendMessage(
      telegramId,
      `💡 You've been journaling for a while, ${profile.name}! Your sections or schedule might need a refresh. Type /settings anytime.`
    );
  }

  await sendEveningPrompt(bot, telegramId, { name: profile.name, missedYesterday: false });
}

function scheduleJobs(bot: Telegraf): void {
  // Stop existing tasks
  while (activeTasks.length > 0) {
    const t = activeTasks.pop();
    t?.stop();
  }

  const users = listOnboardedUsers();
  if (users.length === 0) {
    console.log('[Scheduler] No onboarded users yet — nothing scheduled');
    return;
  }

  for (const user of users) {
    const profile = getProfileForUser(user.id);
    if (!profile) continue;

    const morningCron = timeToCron(profile.morningTime);
    const eveningCron = timeToCron(profile.eveningTime);

    const morningTask = cron.schedule(
      morningCron,
      () => triggerMorningForUser(bot, user.telegram_id).catch((e) => console.error('[Scheduler] morning error:', e)),
      { timezone: profile.timezone }
    );
    const eveningTask = cron.schedule(
      eveningCron,
      () => triggerEveningForUser(bot, user.telegram_id).catch((e) => console.error('[Scheduler] evening error:', e)),
      { timezone: profile.timezone }
    );

    activeTasks.push(morningTask, eveningTask);
    console.log(
      `[Scheduler] ${profile.name} (${user.telegram_id}): ${profile.morningTime} + ${profile.eveningTime} ${profile.timezone}`
    );
  }
}

export function startScheduler(bot: Telegraf): void {
  botRef = bot;
  scheduleJobs(bot);
}

export function reloadScheduler(): void {
  if (!botRef) return;
  console.log('[Scheduler] Reloading...');
  scheduleJobs(botRef);
}
