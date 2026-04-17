import { Telegraf } from 'telegraf';
import { config } from '../config';
import { registerCommands } from './handlers/command.handler';
import { handleMessage } from './handlers/message.handler';
import { registerCallbacks } from './handlers/callback.handler';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  registerCommands(bot);
  registerCallbacks(bot);

  bot.on('text', (ctx) => handleMessage(ctx));

  bot.catch((err, ctx) => {
    console.error(`[Bot] Error for ${ctx.updateType}:`, err);
    ctx.reply('Something went wrong. Please try again.').catch(() => {});
  });

  return bot;
}

export { Telegraf };
