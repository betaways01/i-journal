import { Telegraf } from 'telegraf';
import { config } from '../config';
import { registerCommands } from './handlers/command.handler';
import { handleMessage } from './handlers/message.handler';
import { registerCallbacks } from './handlers/callback.handler';

const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'journal', description: 'Evening journal session' },
  { command: 'morning', description: 'Morning check-in' },
  { command: 'drop', description: 'Freeform entry, anytime' },
  { command: 'vent', description: 'Dump a feeling, no follow-ups' },
  { command: 'last', description: 'Show last journal entry' },
  { command: 'status', description: "Today's journal status" },
  { command: 'catchup', description: "Journal yesterday's entry" },
  { command: 'settings', description: 'Adjust sections, schedule, times' },
  { command: 'storage', description: 'Cloud save options' },
  { command: 'skip', description: 'Skip current session' },
  { command: 'resetsetup', description: 'Rerun adaptive setup' },
  { command: 'health', description: 'Bot status' },
  { command: 'start', description: 'Restart setup or show menu' },
];

async function registerBotCommandsMenu(bot: Telegraf): Promise<void> {
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
    console.log('[Bot] Command menu registered');
  } catch (err) {
    console.error('[Bot] Failed to register command menu:', err);
  }
}

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  registerCommands(bot);
  registerCallbacks(bot);

  bot.on('text', (ctx) => handleMessage(ctx));

  bot.catch((err, ctx) => {
    console.error(`[Bot] Error for ${ctx.updateType}:`, err);
    ctx.reply('Something went wrong. Please try again.').catch(() => {});
  });

  // Fire-and-forget — don't block startup on the menu registration.
  void registerBotCommandsMenu(bot);

  return bot;
}

export { Telegraf };
