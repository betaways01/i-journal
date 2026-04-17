import { createBot } from './bot';
import { startScheduler } from './scheduler';
import { getDb, closeDb } from './db';
import { migrateLegacyJsonIfPresent } from './db/legacy.migrate';

async function main(): Promise<void> {
  console.log('[i-Journal] Starting up...');

  // Initialize DB + run migrations before anything else touches it
  getDb();
  migrateLegacyJsonIfPresent();

  const bot = createBot();

  startScheduler(bot);

  await bot.launch();
  console.log('[i-Journal] Bot is running! Listening for messages...');

  const shutdown = (signal: string) => {
    console.log(`[i-Journal] Shutting down (${signal})...`);
    bot.stop(signal);
    closeDb();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[i-Journal] Fatal error:', error);
  process.exit(1);
});
