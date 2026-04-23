import { getDb } from './index';

export interface JournalEntryRecord {
  id: number;
  user_id: number;
  entry_date: string;
  day_of_week: string;
  session_type: string;
  content_markdown: string;
  onenote_url: string | null;
  saved_to_cloud: number;
  created_at: string;
}

export function saveJournalEntry(params: {
  userId: number;
  entryDate: string;
  dayOfWeek: string;
  sessionType: 'morning' | 'evening' | 'drop';
  contentMarkdown: string;
}): number {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO journal_entries (
        user_id, entry_date, day_of_week, session_type, content_markdown, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, entry_date, session_type) DO UPDATE SET
        content_markdown = excluded.content_markdown,
        day_of_week = excluded.day_of_week
      RETURNING id`
    )
    .get(
      params.userId,
      params.entryDate,
      params.dayOfWeek,
      params.sessionType,
      params.contentMarkdown,
      now
    ) as { id: number };

  return result.id;
}

export function markEntrySavedToCloud(entryId: number, onenoteUrl: string | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE journal_entries SET saved_to_cloud = 1, onenote_url = ? WHERE id = ?`
  ).run(onenoteUrl, entryId);
}

export function getLastEntry(userId: number): JournalEntryRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM journal_entries
       WHERE user_id = ?
       ORDER BY entry_date DESC, created_at DESC
       LIMIT 1`
    )
    .get(userId) as JournalEntryRecord | undefined;
  return row ?? null;
}

export function getEntriesInDateRange(
  userId: number,
  startDate: string,
  endDate: string
): JournalEntryRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM journal_entries
       WHERE user_id = ? AND entry_date BETWEEN ? AND ?
       ORDER BY entry_date ASC`
    )
    .all(userId, startDate, endDate) as JournalEntryRecord[];
}
