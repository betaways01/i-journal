import { Context } from 'telegraf';
import { startCompanionSession, handleCompanionMessage } from './companion.scene';
import { sessionStore } from '../../state/session.store';
import { getUserByTelegramId } from '../../db/users.repo';
import { saveProfileForUser } from '../../db/profile.repo';
import { getDefaultProfile } from '../../profile/defaults';
import { config } from '../../config';

export function startOnboarding(ctx: Context, userId: string): Promise<void> {
  return startCompanionSession(ctx, userId, { mode: 'onboarding' });
}

export function handleOnboardingMessage(ctx: Context, userId: string, text: string): Promise<void> {
  return handleCompanionMessage(ctx, userId, text);
}

export function skipOnboarding(userId: string): void {
  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  const defaults = getDefaultProfile();
  defaults.timezone = config.timezone;
  if (userRow.first_name) defaults.name = userRow.first_name;
  defaults.onboardingComplete = true;
  defaults.createdAt = new Date().toISOString().split('T')[0];
  defaults.lastReviewDate = new Date().toISOString().split('T')[0];
  saveProfileForUser(userRow.id, defaults);
  sessionStore.clear(userId);
  console.log('[Onboarding] Skipped, default profile saved for', userId);
}
