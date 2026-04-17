import { Context } from 'telegraf';
import { upsertUser, getUserByTelegramId, UserRow } from '../db/users.repo';
import { getProfileForUser } from '../db/profile.repo';
import { getDefaultProfile, Profile } from '../profile/defaults';
import { config } from '../config';

export interface BotUser {
  row: UserRow;
  telegramId: string;
  profile: Profile;
  isOwner: boolean;
}

export function registerUserFromContext(ctx: Context): UserRow | null {
  if (!ctx.from) return null;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ?? undefined;
  const firstName = ctx.from.first_name ?? undefined;
  const isOwner = config.telegram.ownerId === telegramId;
  return upsertUser({ telegramId, username, firstName, isOwner });
}

export function loadBotUser(telegramId: string): BotUser | null {
  const row = getUserByTelegramId(telegramId);
  if (!row) return null;
  const profile = getProfileForUser(row.id) ?? defaultProfileForNewUser(row);
  return {
    row,
    telegramId,
    profile,
    isOwner: row.is_owner === 1,
  };
}

export function defaultProfileForNewUser(row: UserRow): Profile {
  const profile = getDefaultProfile();
  if (row.first_name) profile.name = row.first_name;
  profile.timezone = config.timezone;
  return profile;
}
