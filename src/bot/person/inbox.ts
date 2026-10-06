/**
 * Durable inbox: every incoming message is written down before it is processed, so a crash or
 * redeploy mid-turn loses neither the message nor the reply. On start, unfinished messages are
 * replayed; a turn that finished but whose reply may not have been delivered is re-delivered.
 */
import Database from 'better-sqlite3';
import { Inbound } from '../../core/types';

export type InboxState = 'pending' | 'turn_done' | 'done';

export interface InboxRow {
  updateIds: number[];
  userKey: string;
  chatId: number;
  inbound: Inbound;
  state: InboxState;
  receivedAt: string;
  /** The reply written for this message, once the turn finished. */
  reply?: string;
}

export class Inbox {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bot_inbox (
        update_id INTEGER PRIMARY KEY,
        user_key TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        group_key TEXT,
        reply TEXT,
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bot_inbox_state ON bot_inbox(state, received_at);
    `);
  }

  /** Returns false when this update was already recorded (Telegram redelivered it after a crash). */
  record(updateId: number, userKey: string, chatId: number, inbound: Inbound, now = new Date()): boolean {
    const info = this.db
      .prepare('INSERT OR IGNORE INTO bot_inbox (update_id, user_key, chat_id, payload, state, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(updateId, userKey, chatId, JSON.stringify(inbound), 'pending', now.toISOString(), now.toISOString());
    return info.changes > 0;
  }

  /** Album parts are merged into one turn; the merged inbound replaces the first part. */
  group(updateIds: number[], merged: Inbound): void {
    if (!updateIds.length) return;
    const key = 'g' + Math.min(...updateIds);
    const tx = this.db.transaction(() => {
      for (const id of updateIds) this.db.prepare('UPDATE bot_inbox SET group_key = ? WHERE update_id = ?').run(key, id);
      this.db.prepare('UPDATE bot_inbox SET payload = ? WHERE update_id = ?').run(JSON.stringify(merged), Math.min(...updateIds));
    });
    tx();
  }

  mark(updateIds: number[], state: InboxState, reply?: string, now = new Date()): void {
    const stmt = this.db.prepare('UPDATE bot_inbox SET state = ?, reply = COALESCE(?, reply), updated_at = ? WHERE update_id = ?');
    this.db.transaction(() => updateIds.forEach((id) => stmt.run(state, reply ?? null, now.toISOString(), id)))();
  }

  /** Unfinished work, oldest first, album parts folded back into one row. */
  unfinished(): InboxRow[] {
    const rows = this.db.prepare("SELECT * FROM bot_inbox WHERE state != 'done' ORDER BY received_at, update_id").all() as Array<{
      update_id: number;
      user_key: string;
      chat_id: number;
      payload: string;
      state: InboxState;
      group_key: string | null;
      reply: string | null;
      received_at: string;
    }>;
    const out: InboxRow[] = [];
    const groups = new Map<string, InboxRow>();
    for (const r of rows) {
      if (r.group_key && groups.has(r.group_key)) {
        groups.get(r.group_key)!.updateIds.push(r.update_id);
        continue;
      }
      let inbound: Inbound;
      try {
        inbound = JSON.parse(r.payload) as Inbound;
      } catch {
        continue;
      }
      const row: InboxRow = { updateIds: [r.update_id], userKey: r.user_key, chatId: r.chat_id, inbound, state: r.state, receivedAt: r.received_at, reply: r.reply ?? undefined };
      if (r.group_key) groups.set(r.group_key, row);
      out.push(row);
    }
    return out;
  }

  prune(now = new Date(), keepDays = 7): void {
    this.db.prepare("DELETE FROM bot_inbox WHERE state = 'done' AND updated_at < ?").run(new Date(now.getTime() - keepDays * 86_400_000).toISOString());
  }
}
