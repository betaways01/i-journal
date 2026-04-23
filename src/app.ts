import { createBot } from './bot';
import { startScheduler } from './scheduler';
import { startReminderSweeper, stopReminderSweeper } from './scheduler/reminders';
import { getDb, closeDb } from './db';
import { migrateLegacyJsonIfPresent } from './db/legacy.migrate';
import { closeWebServer, startWebServer } from './web';

function isTelegramPollingConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const response = (error as { response?: { error_code?: number } }).response;
  return response?.error_code === 409;
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
    console.log('[i-Journal] Bot is running! Listening for messages...');
  };

  const launchPromise = bot.launch(() => {
    markStarted();
  });

  const shutdown = (signal: string) => {
    console.log(`[i-Journal] Shutting down (${signal})...`);
    bot.stop(signal);
    stopReminderSweeper();
    closeWebServer();
    closeDb();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await launchPromise;
}

main().catch((error) => {
  if (isTelegramPollingConflict(error)) {
    console.error(
      '[i-Journal] Fatal error: another instance is already polling Telegram for this bot token. ' +
        'Stop the other deployment/process or use a different bot token before starting this app.'
    );
  } else {
    console.error('[i-Journal] Fatal error:', error);
  }
  closeWebServer();
  closeDb();
  process.exit(1);
});
