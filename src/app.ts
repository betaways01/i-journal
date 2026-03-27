import { createBot } from './bot';
import { startScheduler } from './scheduler';

async function main(): Promise<void> {
  console.log('[i-Journal] Starting up...');

  const bot = createBot();

  // Start the scheduler
  startScheduler(bot);

  // Launch the bot
  await bot.launch();
  console.log('[i-Journal] Bot is running! Listening for messages...');

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('[i-Journal] Shutting down (SIGINT)...');
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    console.log('[i-Journal] Shutting down (SIGTERM)...');
    bot.stop('SIGTERM');
  });
}

main().catch((error) => {
  console.error('[i-Journal] Fatal error:', error);
  process.exit(1);
});
