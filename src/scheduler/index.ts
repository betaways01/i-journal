import cron, { ScheduledTask } from 'node-cron';
import { Telegraf } from 'telegraf';
import { config } from '../config';
import { getProfile, needsReview } from '../profile';
import {
  sessionStore,
  getJournalState,
  getTodayDateString,
  getYesterdayDateString,
} from '../state/session.store';
import { startMorningSession } from '../bot/scenes/morning.scene';
import { startEveningSession } from '../bot/scenes/evening.scene';

let morningTask: ScheduledTask | null = null;
let eveningTask: ScheduledTask | null = null;
let botRef: Telegraf | null = null;

function createFakeContext(bot: Telegraf, chatId: string) {
  return {
    from: { id: Number(chatId) },
    reply: async (text: string, extra?: object) => {
      await bot.telegram.sendMessage(chatId, text, extra);
    },
  } as any;
}

function timeToCron(time: string): string {
  const [hour, minute] = time.split(':');
  return `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;
}

function schedulJobs(bot: Telegraf): void {
  const ownerId = config.telegram.ownerId;
  const profile = getProfile();
  const morningCron = timeToCron(profile.morningTime);
  const eveningCron = timeToCron(profile.eveningTime);

  morningTask = cron.schedule(
    morningCron,
    async () => {
      console.log('[Scheduler] Morning session triggered');
      const today = getTodayDateString();
      const state = getJournalState();

      if (state.lastMorningDate === today) {
        console.log('[Scheduler] Morning session already completed today');
        return;
      }

      if (sessionStore.has(ownerId)) {
        console.log('[Scheduler] Session already active, skipping morning trigger');
        return;
      }

      const currentProfile = getProfile();
      if (!currentProfile.onboardingComplete) {
        console.log('[Scheduler] Onboarding not complete, skipping morning trigger');
        return;
      }

      const ctx = createFakeContext(bot, ownerId);
      await startMorningSession(ctx, ownerId);
    },
    { timezone: config.timezone }
  );

  eveningTask = cron.schedule(
    eveningCron,
    async () => {
      console.log('[Scheduler] Evening session triggered');
      const today = getTodayDateString();
      const yesterday = getYesterdayDateString();
      const state = getJournalState();

      if (state.lastEveningDate === today) {
        console.log('[Scheduler] Evening session already completed today');
        return;
      }

      if (sessionStore.has(ownerId)) {
        console.log('[Scheduler] Session already active, skipping evening trigger');
        return;
      }

      const currentProfile = getProfile();
      if (!currentProfile.onboardingComplete) {
        console.log('[Scheduler] Onboarding not complete, skipping evening trigger');
        return;
      }

      // Check if yesterday was missed
      if (state.lastEveningDate !== yesterday && state.lastEveningDate !== null) {
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const dayName = yesterdayDate.toLocaleDateString('en-US', {
          weekday: 'long',
          timeZone: config.timezone,
        });

        await bot.telegram.sendMessage(
          ownerId,
          `Hey ${currentProfile.name}, we didn't journal yesterday (${dayName}). Want to do a quick catch-up before today's?\n\nReply *yes* to catch up, or *no* to skip to today.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Seasonal review nudge
      if (needsReview()) {
        await bot.telegram.sendMessage(
          ownerId,
          `💡 You've been journaling for a while, ${currentProfile.name}! Your sections or schedule might need a refresh. Type /settings anytime to adjust.`
        );
      }

      const ctx = createFakeContext(bot, ownerId);
      await startEveningSession(ctx, ownerId);
    },
    { timezone: config.timezone }
  );

  console.log(
    `[Scheduler] Cron jobs registered (${profile.morningTime} + ${profile.eveningTime} ${config.timezone})`
  );
}

export function startScheduler(bot: Telegraf): void {
  botRef = bot;
  schedulJobs(bot);
}

export function reloadScheduler(): void {
  if (!botRef) return;

  // Stop existing cron tasks
  if (morningTask) {
    morningTask.stop();
    morningTask = null;
  }
  if (eveningTask) {
    eveningTask.stop();
    eveningTask = null;
  }

  console.log('[Scheduler] Reloading with updated profile...');
  schedulJobs(botRef);
}
