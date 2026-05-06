import { Context } from 'telegraf';
import { sessionStore } from '../../state/session.store';
import { handleCompanionMessage, startCompanionSession } from '../scenes/companion.scene';
import { handleSettingsMessage } from '../scenes/settings.scene';
import { handleOnboardingMessage, startOnboarding } from '../scenes/onboarding.scene';
import { handleRoutineSetupMessage, maybeStartRoutineFromText } from '../scenes/routine.scene';
import { registerUserFromContext } from '../userContext';
import { getProfileForUser } from '../../db/profile.repo';

export async function handleMessage(ctx: Context): Promise<void> {
  const userRow = registerUserFromContext(ctx);
  if (!userRow) return;

  const message = ctx.message;
  if (!message || !('text' in message)) return;

  const text = message.text;
  if (text.startsWith('/')) return;

  const telegramId = userRow.telegram_id;
  const session = sessionStore.get(telegramId);

  if (session) {
    if (session.sessionType === 'onboarding') {
      await handleOnboardingMessage(ctx, telegramId, text);
      return;
    }
    if (session.sessionType === 'settings') {
      await handleSettingsMessage(ctx, telegramId, text);
      return;
    }
    if (session.sessionType === 'routine_setup') {
      await handleRoutineSetupMessage(ctx, telegramId, text);
      return;
    }
    await handleCompanionMessage(ctx, telegramId, text);
    return;
  }

  const isOnboarded = userRow.onboarding_complete === 1 && Boolean(getProfileForUser(userRow.id));

  if (!isOnboarded) {
    await startOnboarding(ctx, telegramId);
    return;
  }

  if (await maybeStartRoutineFromText(ctx, userRow, text)) {
    return;
  }

  // Onboarded user typed out of the blue — open a drop entry with their message as input.
  await startCompanionSession(ctx, telegramId, { mode: 'drop', initialUserMessage: text });
}
