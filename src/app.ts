import { createBot } from './bot';
import { startScheduler } from './scheduler';
import { startReminderSweeper, stopReminderSweeper } from './scheduler/reminders';
import { startRoutineSweeper, stopRoutineSweeper } from './scheduler/routines';
import { getDb, closeDb } from './db';
import { migrateLegacyJsonIfPresent } from './db/legacy.migrate';
import { closeWebServer, startWebServer } from './web';

function isTelegramPollingConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const response = (error as { response?: { error_code?: number } }).response;
  return response?.error_code === 409;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('[i-Journal] Starting up...');

  // Initialize DB + run migrations before anything else touches it
  getDb();
  migrateLegacyJsonIfPresent();

  const bot = createBot();

  startWebServer(bot);
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    startScheduler(bot);
    startReminderSweeper(bot);
    startRoutineSweeper(bot);
    console.log('[i-Journal] Bot is running! Listening for messages...');
  };

  const launchWithRetry = async () => {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await bot.launch();
        markStarted();
        return;
      } catch (error) {
        if (!isTelegramPollingConflict(error) || attempt === maxAttempts) {
          throw error;
        }
        const delayMs = Math.min(5000 * attempt, 20_000);
        console.warn(
          `[i-Journal] Telegram polling is still held by another instance. Retrying in ${Math.round(delayMs / 1000)}s...`
        );
        await sleep(delayMs);
      }
    }
  };

  const shutdown = (signal: string) => {
    console.log(`[i-Journal] Shutting down (${signal})...`);
    bot.stop(signal);
    stopReminderSweeper();
    stopRoutineSweeper();
    closeWebServer();
    closeDb();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await launchWithRetry();
}

main().catch((error) => {
  if (isTelegramPollingConflict(error)) {
    console.error(
      '[i-Journal] Fatal error: Telegram polling stayed locked by another instance after startup retries.'
    );
  } else {
    console.error('[i-Journal] Fatal error:', error);
  }
  closeWebServer();
  closeDb();
  process.exit(1);
});
