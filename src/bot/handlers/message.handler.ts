import { Context } from 'telegraf';
import { sessionStore } from '../../state/session.store';
import { handleMorningMessage } from '../scenes/morning.scene';
import { handleEveningMessage } from '../scenes/evening.scene';
import { handleOnboardingMessage } from '../scenes/onboarding.scene';
import { handleSettingsMessage } from '../scenes/settings.scene';
import { registerUserFromContext } from '../userContext';

export function handleMessage(ctx: Context): void {
  const userRow = registerUserFromContext(ctx);
  if (!userRow) return;

  const message = ctx.message;
  if (!message || !('text' in message)) return;

  const text = message.text;
  if (text.startsWith('/')) return;

  const telegramId = userRow.telegram_id;
  const session = sessionStore.get(telegramId);
  if (!session) {
    ctx.reply(
      'No active session right now. Use /morning or /journal to start one, or wait for the scheduled prompt. 🙂'
    );
    return;
  }

  switch (session.sessionType) {
    case 'morning':
      handleMorningMessage(ctx, telegramId, text);
      break;
    case 'evening':
      handleEveningMessage(ctx, telegramId, text);
      break;
    case 'onboarding':
      handleOnboardingMessage(ctx, telegramId, text);
      break;
    case 'settings':
      handleSettingsMessage(ctx, telegramId, text);
      break;
  }
}
