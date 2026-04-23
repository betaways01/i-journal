import { getDb } from '../db';
import { getEntriesInDateRange, JournalEntryRecord } from '../db/entries.repo';
import { MemoryContext } from './prompts/companion';

const WEEK_DAYS = 7;
const THEME_LOOKBACK_DAYS = 14;
const MAX_YESTERDAY_CHARS = 1800;
const MAX_WEEK_CHARS = 2400;

function dateNDaysBack(from: Date, days: number, timezone: string): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('en-CA', { timeZone: timezone });
}

function trimEntry(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max).trimEnd() + '…';
}

function summarizeEntryLine(entry: JournalEntryRecord): string {
  const firstParagraph = entry.content_markdown
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .slice(0, 2)
    .join(' ')
    .trim();
  const snippet = firstParagraph.length > 260 ? firstParagraph.slice(0, 260).trimEnd() + '…' : firstParagraph;
  const marker = entry.session_type === 'morning' ? '☀️' : entry.session_type === 'evening' ? '🌙' : '·';
  return `${entry.entry_date} ${marker} ${snippet || '(brief entry)'}`;
}

function computeStreak(userId: number, today: string, timezone: string): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT entry_date FROM journal_entries WHERE user_id = ? ORDER BY entry_date DESC LIMIT 60`
    )
    .all(userId) as { entry_date: string }[];

  if (rows.length === 0) return 0;

  const dates = new Set(rows.map((r) => r.entry_date));

  // Find the most recent entry date; count consecutive days back from there.
  // If today has no entry yet, we start from the most recent day that does.
  let streak = 0;
  const startDate = dates.has(today) ? new Date(today + 'T12:00:00Z') : new Date(rows[0].entry_date + 'T12:00:00Z');

  for (let i = 0; i < 60; i++) {
    const cursorStr = startDate.toLocaleDateString('en-CA', { timeZone: timezone });
    if (dates.has(cursorStr)) {
      streak += 1;
      startDate.setDate(startDate.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function daysBetween(a: string, b: string): number {
  const aTime = new Date(a + 'T00:00:00Z').getTime();
  const bTime = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((bTime - aTime) / (1000 * 60 * 60 * 24));
}

function extractThemes(entries: JournalEntryRecord[]): string[] {
  const counts = new Map<string, number>();
  const keywords = [
    'work', 'deadline', 'meeting', 'project', 'team', 'client',
    'family', 'wife', 'husband', 'son', 'daughter', 'mom', 'dad', 'parent',
    'prayer', 'faith', 'god', 'church', 'scripture', 'bible',
    'tired', 'exhausted', 'sleep', 'stressed', 'anxious', 'overwhelmed',
    'grateful', 'thankful', 'joy', 'rest',
    'health', 'workout', 'walk', 'eating',
    'money', 'bills', 'savings',
    'friend', 'conversation', 'call',
    'learning', 'study', 'reading', 'book',
  ];

  for (const e of entries) {
    const lower = e.content_markdown.toLowerCase();
    for (const kw of keywords) {
      const matches = lower.match(new RegExp(`\\b${kw}\\b`, 'g'));
      if (matches) {
        counts.set(kw, (counts.get(kw) || 0) + matches.length);
      }
    }
  }

  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([kw]) => kw);
}

export function loadMemoryContext(userId: number, now: Date, timezone: string): MemoryContext {
  const today = now.toLocaleDateString('en-CA', { timeZone: timezone });
  const weekStart = dateNDaysBack(now, WEEK_DAYS, timezone);
  const themeStart = dateNDaysBack(now, THEME_LOOKBACK_DAYS, timezone);

  const weekEntries = getEntriesInDateRange(userId, weekStart, today);
  const themeEntries = getEntriesInDateRange(userId, themeStart, today);

  const sorted = [...weekEntries].sort((a, b) => {
    const byDate = b.entry_date.localeCompare(a.entry_date);
    if (byDate !== 0) return byDate;
    return b.created_at.localeCompare(a.created_at);
  });

  const yesterdayRaw = sorted[0]?.content_markdown ?? null;
  const yesterdayEntry = yesterdayRaw ? trimEntry(yesterdayRaw, MAX_YESTERDAY_CHARS) : null;

  const weekLines = sorted.slice(1, 8).map(summarizeEntryLine);
  let weekSummary: string | null = null;
  if (weekLines.length > 0) {
    const joined = weekLines.join('\n');
    weekSummary = joined.length > MAX_WEEK_CHARS ? joined.slice(0, MAX_WEEK_CHARS).trimEnd() + '…' : joined;
  }

  const streakDays = computeStreak(userId, today, timezone);

  let daysSinceLastEntry: number | null = null;
  if (sorted.length > 0) {
    daysSinceLastEntry = Math.max(0, daysBetween(sorted[0].entry_date, today));
  }

  const recentThemes = extractThemes(themeEntries);

  return {
    yesterdayEntry,
    weekSummary,
    streakDays,
    daysSinceLastEntry,
    recentThemes,
  };
}
