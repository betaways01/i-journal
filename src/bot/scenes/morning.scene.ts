import { Context } from 'telegraf';
import { startCompanionSession, handleCompanionMessage } from './companion.scene';

export function startMorningSession(ctx: Context, userId: string): Promise<void> {
  return startCompanionSession(ctx, userId, { mode: 'morning' });
}

export function handleMorningMessage(ctx: Context, userId: string, text: string): Promise<void> {
  return handleCompanionMessage(ctx, userId, text);
}
