import { Telegraf } from 'telegraf';
import { config } from '../config';
import { registerCommands } from './handlers/command.handler';
import { handleMessage } from './handlers/message.handler';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  // Register command handlers
  registerCommands(bot);

  // Register message handler for conversational flow
  bot.on('text', (ctx) => handleMessage(ctx));

  // Error handling
  bot.catch((err, ctx) => {
    console.error(`[Bot] Error for ${ctx.updateType}:`, err);
    ctx.reply('Something went wrong. Please try again.').catch(() => {});
  });

  return bot;
}

export { Telegraf };
