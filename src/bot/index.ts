import { Telegraf } from 'telegraf';
import { Logger } from '../core/types';

/** Update types the bot asks Telegram for (reactions are not sent unless asked). */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction'] as const;

export function createBot(token: string, log: Logger): Telegraf {
  const bot = new Telegraf(token, { handlerTimeout: 60_000 });
  bot.catch((err, ctx) => {
    log.error('telegram handler failed', { updateType: ctx.updateType, error: err instanceof Error ? err.stack || err.message : String(err) });
  });
  return bot;
}

/** The command menu everyone sees, plus owner-only extras in the owner's chat. */
export async function registerCommandMenu(
  bot: Telegraf,
  commands: Array<{ command: string; description: string }>,
  log: Logger,
  owner?: { chatId: string; extra: Array<{ command: string; description: string }> }
): Promise<void> {
  try {
    await bot.telegram.setMyCommands(commands);
    if (owner?.chatId) await bot.telegram.setMyCommands([...commands, ...owner.extra], { scope: { type: 'chat', chat_id: Number(owner.chatId) } });
    log.info('command menu registered', { commands: commands.map((c) => c.command).join(','), ownerExtras: owner?.extra.map((c) => c.command).join(',') });
  } catch (err) {
    log.warn('could not register the command menu', { error: err instanceof Error ? err.message : String(err) });
  }
}

export { Telegraf };
