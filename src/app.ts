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

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode?: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[i-Journal] Shutting down (${signal})...`);
    try {
      bot.stop(signal);
    } catch (err) {
      console.error('[i-Journal] bot.stop failed:', err);
    }
    stopReminderSweeper();
    stopRoutineSweeper();
    closeWebServer();
    closeDb();
    if (typeof exitCode === 'number') {
      // Let logs flush, then exit so the platform restarts cleanly and the Telegram polling
      // lock is released promptly for the next instance.
      setTimeout(() => process.exit(exitCode), 250);
    }
  };

  // Exit fast and clean on platform stop signals so a redeploy's new instance can acquire the
  // Telegram polling lock without a long 409 overlap (the thing that makes deploys look crashed).
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));

  // Last-resort safety nets. Previously a process-level crash vanished with no stack trace.
  process.on('uncaughtException', (err) => {
    console.error('[i-Journal] uncaughtException — exiting for a clean restart:', err);
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    // Log loudly but stay up: one stray dropped promise (e.g. a failed Telegram send) must not
    // take the whole bot down for every user. Genuine bugs are still surfaced here for follow-up.
    console.error('[i-Journal] unhandledRejection (continuing):', reason);
  });

  // Resilient launch: drop the backlog on (re)start so a poison message can't crash-loop, and
  // treat a 409 "another instance is polling" as a transient deploy overlap — wait it out with
  // backoff instead of crashing.
  const launchWithRetry = async (): Promise<void> => {
    const startedAt = Date.now();
    const maxWaitMs = 5 * 60 * 1000;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await bot.launch({ dropPendingUpdates: true }, markStarted);
        return;
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        if (!isTelegramPollingConflict(error) || elapsedMs > maxWaitMs) {
          throw error;
        }
        const delayMs = Math.min(3000 * attempt, 15_000);
        console.warn(
          `[i-Journal] Telegram polling held by a previous instance (deploy overlap). ` +
            `Waiting ${Math.round(delayMs / 1000)}s (attempt ${attempt})...`
        );
        await sleep(delayMs);
      }
    }
  };

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
