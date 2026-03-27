import { Context } from 'telegraf';
import { config } from '../../config';
import { sessionStore } from '../../state/session.store';
import { handleMorningMessage } from '../scenes/morning.scene';
import { handleEveningMessage } from '../scenes/evening.scene';
import { handleOnboardingMessage } from '../scenes/onboarding.scene';
import { handleSettingsMessage } from '../scenes/settings.scene';

export function handleMessage(ctx: Context): void {
  const userId = String(ctx.from?.id);

  if (userId !== config.telegram.ownerId) return;

  const message = ctx.message;
  if (!message || !('text' in message)) return;

  const text = message.text;

  if (text.startsWith('/')) return;

  const session = sessionStore.get(userId);
  if (!session) {
    ctx.reply(
      'No active session right now. Use /morning or /journal to start one, or wait for the scheduled prompt. 🙂'
    );
    return;
  }

  switch (session.sessionType) {
    case 'morning':
      handleMorningMessage(ctx, userId, text);
      break;
    case 'evening':
      handleEveningMessage(ctx, userId, text);
      break;
    case 'onboarding':
      handleOnboardingMessage(ctx, userId, text);
      break;
    case 'settings':
      handleSettingsMessage(ctx, userId, text);
      break;
  }
}
