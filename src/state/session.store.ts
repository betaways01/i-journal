import { ConversationState } from '../types';
import { getUserByTelegramId, upsertUser } from '../db/users.repo';
import {
  getSessionForUser,
  setSessionForUser,
  clearSessionForUser,
  hasSessionForUser,
} from '../db/sessions.repo';
import {
  getJournalStateForUser,
  updateJournalStateForUser,
  JournalState,
} from '../db/journalState.repo';
import { config } from '../config';

function resolveUserId(telegramId: string): number {
  const user = getUserByTelegramId(telegramId);
  if (user) return user.id;
  const created = upsertUser({ telegramId });
  return created.id;
}

export const sessionStore = {
  get: (telegramId: string): ConversationState | undefined => {
    const user = getUserByTelegramId(telegramId);
    if (!user) return undefined;
    return getSessionForUser(user.id) ?? undefined;
  },
  set: (telegramId: string, state: ConversationState): void => {
    const uid = resolveUserId(telegramId);
    const targetDate = state.startedAt.toLocaleDateString('en-CA', { timeZone: config.timezone });
    setSessionForUser(uid, state, targetDate);
  },
  clear: (telegramId: string): void => {
    const user = getUserByTelegramId(telegramId);
    if (!user) return;
    clearSessionForUser(user.id);
  },
  has: (telegramId: string): boolean => {
    const user = getUserByTelegramId(telegramId);
    if (!user) return false;
    return hasSessionForUser(user.id);
  },
};

export function getJournalState(telegramId: string): JournalState {
  const user = getUserByTelegramId(telegramId);
  if (!user) return { lastMorningDate: null, lastEveningDate: null };
  return getJournalStateForUser(user.id);
}

export function updateJournalState(
  telegramId: string,
  updates: Partial<JournalState>
): void {
  const uid = resolveUserId(telegramId);
  updateJournalStateForUser(uid, updates);
}

export function getTodayDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

export function getYesterdayDateString(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return now.toLocaleDateString('en-CA', { timeZone: config.timezone });
}

export function getTodayDateStringInZone(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

export function getYesterdayDateStringInZone(timezone: string): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return now.toLocaleDateString('en-CA', { timeZone: timezone });
}
