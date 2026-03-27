import fs from 'fs';
import path from 'path';
import { ConversationState } from '../types';

const sessions = new Map<string, ConversationState>();

export const sessionStore = {
  get: (userId: string) => sessions.get(userId),
  set: (userId: string, state: ConversationState) => sessions.set(userId, state),
  clear: (userId: string) => sessions.delete(userId),
  has: (userId: string) => sessions.has(userId),
};

interface JournalState {
  lastMorningDate: string | null;
  lastEveningDate: string | null;
}

const STATE_FILE = path.join(__dirname, '../../state/journal.state.json');

function ensureStateDir(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getJournalState(): JournalState {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { lastMorningDate: null, lastEveningDate: null };
  }
}

export function updateJournalState(updates: Partial<JournalState>): void {
  ensureStateDir();
  const current = getJournalState();
  const updated = { ...current, ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2));
}

export function getTodayDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}

export function getYesterdayDateString(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return now.toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}
