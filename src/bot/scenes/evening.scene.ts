import { Context } from 'telegraf';
import { startCompanionSession, handleCompanionMessage } from './companion.scene';

export function startEveningSession(
  ctx: Context,
  userId: string,
  targetDate?: Date
): Promise<void> {
  return startCompanionSession(ctx, userId, { mode: 'evening', targetDate });
}

export function handleEveningMessage(ctx: Context, userId: string, text: string): Promise<void> {
  return handleCompanionMessage(ctx, userId, text);
}
