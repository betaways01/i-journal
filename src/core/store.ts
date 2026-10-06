import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  Fact,
  FactKind,
  InboundMedia,
  JournalDay,
  JournalEntry,
  JournalHit,
  NewMessage,
  Note,
  NoteHit,
  Profile,
  Recurrence,
  Reminder,
  Skill,
  Store,
  StoredMessage,
  ToolCall,
  TurnRecord,
  TurnToolLog,
  IssueRecord,
  UserState,
} from './types';
import { weekdayOf } from './time';

export function openCoreDb(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function defaultState(): UserState {
  return { journalOpen: false, undo: [], summary: '', summaryThrough: 0, turnCount: 0 };
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS core_profile (
        user_key TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_state (
        user_key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_facts_user ON core_facts(user_key, id);
      CREATE TABLE IF NOT EXISTS core_skills (
        user_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_key, name)
      );
      CREATE TABLE IF NOT EXISTS core_journal_days (
        user_key TEXT NOT NULL,
        date TEXT NOT NULL,
        reflection TEXT,
        closed_at TEXT,
        updated_at TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        synced_rev INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        remote_page_id TEXT,
        remote_url TEXT,
        PRIMARY KEY (user_key, date)
      );
      CREATE TABLE IF NOT EXISTS core_journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        date TEXT NOT NULL,
        at TEXT NOT NULL,
        local_time TEXT NOT NULL,
        text TEXT NOT NULL,
        media_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS core_journal_entries_day ON core_journal_entries(user_key, date, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS core_journal_fts USING fts5(
        text, content='core_journal_entries', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS core_journal_ai AFTER INSERT ON core_journal_entries BEGIN
        INSERT INTO core_journal_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS core_journal_ad AFTER DELETE ON core_journal_entries BEGIN
        INSERT INTO core_journal_fts(core_journal_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS core_journal_au AFTER UPDATE OF text ON core_journal_entries BEGIN
        INSERT INTO core_journal_fts(core_journal_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO core_journal_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TABLE IF NOT EXISTS core_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        notebook TEXT NOT NULL,
        section TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        synced_rev INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        remote_page_id TEXT,
        remote_url TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS core_notes_path ON core_notes(
        user_key, notebook COLLATE NOCASE, section COLLATE NOCASE, title COLLATE NOCASE
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS core_notes_fts USING fts5(
        notebook, section, title, body, content='core_notes', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS core_notes_ai AFTER INSERT ON core_notes BEGIN
        INSERT INTO core_notes_fts(rowid, notebook, section, title, body) VALUES (new.id, new.notebook, new.section, new.title, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS core_notes_ad AFTER DELETE ON core_notes BEGIN
        INSERT INTO core_notes_fts(core_notes_fts, rowid, notebook, section, title, body) VALUES ('delete', old.id, old.notebook, old.section, old.title, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS core_notes_au AFTER UPDATE OF notebook, section, title, body ON core_notes BEGIN
        INSERT INTO core_notes_fts(core_notes_fts, rowid, notebook, section, title, body) VALUES ('delete', old.id, old.notebook, old.section, old.title, old.body);
        INSERT INTO core_notes_fts(rowid, notebook, section, title, body) VALUES (new.id, new.notebook, new.section, new.title, new.body);
      END;
      CREATE TABLE IF NOT EXISTS core_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls_json TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        at TEXT NOT NULL,
        media_json TEXT,
        origin TEXT
      );
      CREATE INDEX IF NOT EXISTS core_messages_user ON core_messages(user_key, id);
      CREATE TABLE IF NOT EXISTS core_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        recurrence_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        last_fired_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at TEXT
      );
      CREATE INDEX IF NOT EXISTS core_reminders_due ON core_reminders(status, fire_at);
      CREATE INDEX IF NOT EXISTS core_reminders_user ON core_reminders(user_key, status, fire_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS core_messages_fts USING fts5(
        content, user_key UNINDEXED, msg_id UNINDEXED, role UNINDEXED, at UNINDEXED, tokenize='porter unicode61 remove_diacritics 2'
      );
      INSERT INTO core_messages_fts(content, user_key, msg_id, role, at)
        SELECT content, user_key, id, role, at FROM core_messages WHERE role IN ('user', 'assistant') AND length(content) > 0;
      CREATE TRIGGER IF NOT EXISTS core_messages_fts_ai AFTER INSERT ON core_messages
        WHEN new.role IN ('user', 'assistant') AND length(new.content) > 0 BEGIN
        INSERT INTO core_messages_fts(content, user_key, msg_id, role, at) VALUES (new.content, new.user_key, new.id, new.role, new.at);
      END;
      CREATE TRIGGER IF NOT EXISTS core_messages_fts_ad AFTER DELETE ON core_messages BEGIN
        DELETE FROM core_messages_fts WHERE msg_id = old.id;
      END;
      CREATE TABLE IF NOT EXISTS core_secrets (
        user_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        hosts_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_key, name)
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS core_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        ms INTEGER NOT NULL DEFAULT 0,
        rounds INTEGER NOT NULL DEFAULT 0,
        tools_json TEXT NOT NULL DEFAULT '[]',
        corrections_json TEXT NOT NULL DEFAULT '[]',
        effects_json TEXT NOT NULL DEFAULT '[]',
        degraded TEXT,
        silent INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        reply_chars INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        message_ids_json TEXT,
        feedback TEXT,
        feedback_score INTEGER,
        feedback_at TEXT
      );
      CREATE INDEX IF NOT EXISTS core_turns_at ON core_turns(at);
      CREATE INDEX IF NOT EXISTS core_turns_user ON core_turns(user_key, id);
      CREATE TABLE IF NOT EXISTS core_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        at TEXT NOT NULL,
        turn_id INTEGER,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_issues_at ON core_issues(at);
    `,
  },
];

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function opt(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Turns arbitrary user text into a safe FTS5 expression: every token quoted, operators dropped,
 * tokens ORed (bm25 then ranks entries with more of the words higher), prefix match for 3+ chars.
 */
export function ftsQuery(query: string): string | null {
  const tokens = (String(query || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 24);
  const uniq = [...new Set(tokens)];
  if (!uniq.length) return null;
  return uniq.map((t) => `"${t}"${t.length >= 3 ? '*' : ''}`).join(' OR ');
}

function likeTokens(query: string): string[] {
  return [...new Set(String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2))].slice(0, 12);
}

export class SqliteStore implements Store {
  private readonly stmts = new Map<string, Database.Statement>();
  private readonly secretKey: Buffer;

  /** `secretKey` encrypts stored secrets (32 bytes after hashing). Pass something stable per deployment. */
  constructor(
    private readonly db: Database.Database,
    opts: { secretKey?: string } = {}
  ) {
    this.secretKey = crypto.createHash('sha256').update(opts.secretKey || 'i-journal-local-secrets').digest();
    db.exec(`CREATE TABLE IF NOT EXISTS core_schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const current = (db.prepare('SELECT MAX(version) AS v FROM core_schema_version').get() as { v: number | null }).v ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO core_schema_version (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      })();
    }
  }

  private q(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------
  // profile + state
  // -------------------------------------------------------------------------

  getProfile(userKey: string): Profile {
    const r = this.q('SELECT name, agent_name, timezone FROM core_profile WHERE user_key = ?').get(userKey) as Row | undefined;
    if (!r) return { name: '', agentName: '', timezone: '' };
    return { name: str(r.name), agentName: str(r.agent_name), timezone: str(r.timezone) };
  }

  saveProfile(userKey: string, profile: Profile): void {
    this.q(
      `INSERT INTO core_profile (user_key, name, agent_name, timezone, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET name = excluded.name, agent_name = excluded.agent_name,
       timezone = excluded.timezone, updated_at = excluded.updated_at`
    ).run(userKey, profile.name || '', profile.agentName || '', profile.timezone || '', new Date().toISOString());
  }

  getState(userKey: string): UserState {
    const r = this.q('SELECT json FROM core_state WHERE user_key = ?').get(userKey) as Row | undefined;
    const base = defaultState();
    if (!r) return base;
    const saved = parseJson<Partial<UserState>>(r.json, {});
    const merged: UserState = { ...base, ...(saved && typeof saved === 'object' ? saved : {}) };
    if (!Array.isArray(merged.undo)) merged.undo = [];
    if (typeof merged.summary !== 'string') merged.summary = '';
    if (typeof merged.summaryThrough !== 'number' || !Number.isFinite(merged.summaryThrough)) merged.summaryThrough = 0;
    if (typeof merged.turnCount !== 'number' || !Number.isFinite(merged.turnCount)) merged.turnCount = 0;
    merged.journalOpen = Boolean(merged.journalOpen);
    return merged;
  }

  saveState(userKey: string, state: UserState): void {
    this.q(
      `INSERT INTO core_state (user_key, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
    ).run(userKey, JSON.stringify(state), new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // facts
  // -------------------------------------------------------------------------

  private factFrom(r: Row): Fact {
    return { id: Number(r.id), kind: (str(r.kind) === 'instruction' ? 'instruction' : 'fact') as FactKind, text: str(r.text), createdAt: str(r.created_at) };
  }

  listFacts(userKey: string): Fact[] {
    return (this.q('SELECT * FROM core_facts WHERE user_key = ? ORDER BY id').all(userKey) as Row[]).map((r) => this.factFrom(r));
  }

  addFact(userKey: string, kind: FactKind, text: string, now: Date): { fact: Fact; created: boolean } {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('fact text is empty');
    const existing = this.q('SELECT * FROM core_facts WHERE user_key = ? AND text = ? COLLATE NOCASE').get(userKey, clean) as Row | undefined;
    if (existing) return { fact: this.factFrom(existing), created: false };
    const info = this.q('INSERT INTO core_facts (user_key, kind, text, created_at) VALUES (?, ?, ?, ?)').run(
      userKey,
      kind === 'instruction' ? 'instruction' : 'fact',
      clean,
      now.toISOString()
    );
    return { fact: this.factFrom(this.q('SELECT * FROM core_facts WHERE id = ?').get(info.lastInsertRowid) as Row), created: true };
  }

  removeFact(userKey: string, id: number): Fact | null {
    const r = this.q('SELECT * FROM core_facts WHERE user_key = ? AND id = ?').get(userKey, id) as Row | undefined;
    if (!r) return null;
    this.q('DELETE FROM core_facts WHERE id = ?').run(id);
    return this.factFrom(r);
  }

  restoreFact(userKey: string, fact: Fact): void {
    this.q('INSERT OR IGNORE INTO core_facts (id, user_key, kind, text, created_at) VALUES (?, ?, ?, ?, ?)').run(
      fact.id,
      userKey,
      fact.kind,
      fact.text,
      fact.createdAt
    );
  }

  // -------------------------------------------------------------------------
  // skills
  // -------------------------------------------------------------------------

  private skillFrom(r: Row): Skill {
    return { name: str(r.name), description: str(r.description), body: str(r.body), updatedAt: str(r.updated_at) };
  }

  listSkills(userKey: string): Skill[] {
    return (this.q('SELECT * FROM core_skills WHERE user_key = ? ORDER BY name').all(userKey) as Row[]).map((r) => this.skillFrom(r));
  }

  getSkill(userKey: string, name: string): Skill | null {
    const r = this.q('SELECT * FROM core_skills WHERE user_key = ? AND name = ?').get(userKey, name) as Row | undefined;
    return r ? this.skillFrom(r) : null;
  }

  saveSkill(userKey: string, skill: Omit<Skill, 'updatedAt'>, now: Date): Skill {
    this.q(
      `INSERT INTO core_skills (user_key, name, description, body, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_key, name) DO UPDATE SET description = excluded.description, body = excluded.body, updated_at = excluded.updated_at`
    ).run(userKey, skill.name, skill.description, skill.body, now.toISOString());
    return this.getSkill(userKey, skill.name) as Skill;
  }

  removeSkill(userKey: string, name: string): boolean {
    return this.q('DELETE FROM core_skills WHERE user_key = ? AND name = ?').run(userKey, name).changes > 0;
  }

  // -------------------------------------------------------------------------
  // journal
  // -------------------------------------------------------------------------

  private entryFrom(r: Row): JournalEntry {
    return {
      id: Number(r.id),
      at: str(r.at),
      localTime: str(r.local_time),
      text: str(r.text),
      media: parseJson<InboundMedia[]>(r.media_json, []),
    };
  }

  getDay(userKey: string, date: string): JournalDay | null {
    const d = this.q('SELECT * FROM core_journal_days WHERE user_key = ? AND date = ?').get(userKey, date) as Row | undefined;
    if (!d) return null;
    const entries = (this.q('SELECT * FROM core_journal_entries WHERE user_key = ? AND date = ? ORDER BY id').all(userKey, date) as Row[]).map((r) =>
      this.entryFrom(r)
    );
    return {
      date,
      weekday: weekdayOf(date),
      entries,
      reflection: opt(d.reflection),
      closedAt: opt(d.closed_at),
      updatedAt: str(d.updated_at),
      rev: Number(d.rev),
      syncedRev: Number(d.synced_rev),
      syncedAt: opt(d.synced_at),
      remotePageId: opt(d.remote_page_id),
      remoteUrl: opt(d.remote_url),
    };
  }

  listDays(userKey: string, opts: { from?: string; to?: string; limit?: number } = {}): Array<{ date: string; weekday: string; entries: number; closed: boolean }> {
    const rows = this.q(
      `SELECT d.date, d.closed_at, COUNT(e.id) AS n FROM core_journal_days d
       JOIN core_journal_entries e ON e.user_key = d.user_key AND e.date = d.date
       WHERE d.user_key = ? AND d.date >= ? AND d.date <= ?
       GROUP BY d.date ORDER BY d.date DESC LIMIT ?`
    ).all(userKey, opts.from || '0000-00-00', opts.to || '9999-99-99', Math.max(1, Math.min(opts.limit ?? 1000, 10000))) as Row[];
    return rows.map((r) => ({ date: str(r.date), weekday: weekdayOf(str(r.date)), entries: Number(r.n), closed: r.closed_at != null }));
  }

  private touchDay(userKey: string, date: string, now: string): void {
    this.q(
      `INSERT INTO core_journal_days (user_key, date, updated_at, rev, synced_rev) VALUES (?, ?, ?, 1, 0)
       ON CONFLICT(user_key, date) DO UPDATE SET updated_at = excluded.updated_at, rev = core_journal_days.rev + 1`
    ).run(userKey, date, now);
  }

  addEntry(
    userKey: string,
    date: string,
    entry: { text: string; media: InboundMedia[]; at: Date; localTime: string }
  ): { day: JournalDay; entry: JournalEntry } {
    const id = this.db.transaction(() => {
      this.touchDay(userKey, date, new Date().toISOString());
      return this.q(
        'INSERT INTO core_journal_entries (user_key, date, at, local_time, text, media_json) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userKey, date, entry.at.toISOString(), entry.localTime, entry.text, JSON.stringify(entry.media || [])).lastInsertRowid;
    })();
    const day = this.getDay(userKey, date) as JournalDay;
    return { day, entry: day.entries.find((e) => e.id === Number(id)) as JournalEntry };
  }

  removeEntry(userKey: string, date: string, entryId: number): JournalEntry | null {
    return this.db.transaction(() => {
      const r = this.q('SELECT * FROM core_journal_entries WHERE user_key = ? AND date = ? AND id = ?').get(userKey, date, entryId) as Row | undefined;
      if (!r) return null;
      this.q('DELETE FROM core_journal_entries WHERE id = ?').run(entryId);
      this.touchDay(userKey, date, new Date().toISOString());
      return this.entryFrom(r);
    })();
  }

  setReflection(userKey: string, date: string, reflection: string | undefined, closedAt: Date | undefined): JournalDay | null {
    const info = this.q(
      'UPDATE core_journal_days SET reflection = ?, closed_at = ?, updated_at = ?, rev = rev + 1 WHERE user_key = ? AND date = ?'
    ).run(reflection ?? null, closedAt ? closedAt.toISOString() : null, new Date().toISOString(), userKey, date);
    return info.changes ? this.getDay(userKey, date) : null;
  }

  markDaySynced(userKey: string, date: string, info: { at: Date; rev?: number; remotePageId?: string; remoteUrl?: string }): void {
    this.q(
      `UPDATE core_journal_days SET synced_rev = MAX(synced_rev, COALESCE(?, rev)), synced_at = ?,
       remote_page_id = COALESCE(?, remote_page_id), remote_url = COALESCE(?, remote_url)
       WHERE user_key = ? AND date = ?`
    ).run(info.rev ?? null, info.at.toISOString(), info.remotePageId ?? null, info.remoteUrl ?? null, userKey, date);
  }

  dirtyDays(userKey: string): JournalDay[] {
    const rows = this.q(
      `SELECT d.date FROM core_journal_days d WHERE d.user_key = ? AND d.rev > d.synced_rev
       AND (d.reflection IS NOT NULL OR EXISTS (SELECT 1 FROM core_journal_entries e WHERE e.user_key = d.user_key AND e.date = d.date))
       ORDER BY d.date`
    ).all(userKey) as Row[];
    return rows.map((r) => this.getDay(userKey, str(r.date)) as JournalDay);
  }

  searchJournal(userKey: string, query: string, opts: { from?: string; to?: string; limit?: number } = {}): JournalHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
    const from = opts.from || '0000-00-00';
    const to = opts.to || '9999-99-99';
    const expr = ftsQuery(query);
    if (expr) {
      try {
        // CROSS JOIN pins the FTS table as the outer loop; with a date filter the planner otherwise
        // scans entries and probes the index once per row (~400x slower at 5k entries).
        const rows = this.q(
          `SELECT e.id, e.date, e.local_time, snippet(core_journal_fts, 0, '', '', '…', 32) AS snip, bm25(core_journal_fts) AS rank
           FROM core_journal_fts CROSS JOIN core_journal_entries e ON e.id = core_journal_fts.rowid
           WHERE core_journal_fts MATCH ? AND e.user_key = ? AND e.date >= ? AND e.date <= ?
           ORDER BY rank, e.date DESC LIMIT ?`
        ).all(expr, userKey, from, to, limit) as Row[];
        if (rows.length) {
          return rows.map((r) => ({
            date: str(r.date),
            weekday: weekdayOf(str(r.date)),
            entryId: Number(r.id),
            localTime: str(r.local_time),
            snippet: str(r.snip).slice(0, 240),
            score: -Number(r.rank),
          }));
        }
      } catch {
        // fall through to a plain scan
      }
    }
    const tokens = likeTokens(query);
    if (!tokens.length) return [];
    const rows = this.q(
      'SELECT id, date, local_time, text FROM core_journal_entries WHERE user_key = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 5000'
    ).all(userKey, from, to) as Row[];
    return rows
      .map((r) => {
        const text = str(r.text);
        const hay = text.toLowerCase();
        const score = tokens.filter((t) => hay.includes(t)).length;
        return { r, text, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r, text, score }) => ({
        date: str(r.date),
        weekday: weekdayOf(str(r.date)),
        entryId: Number(r.id),
        localTime: str(r.local_time),
        snippet: text.slice(0, 240),
        score,
      }));
  }

  // -------------------------------------------------------------------------
  // notes
  // -------------------------------------------------------------------------

  private noteFrom(r: Row): Note {
    return {
      id: Number(r.id),
      notebook: str(r.notebook),
      section: str(r.section),
      title: str(r.title),
      body: str(r.body),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      rev: Number(r.rev),
      syncedRev: Number(r.synced_rev),
      syncedAt: opt(r.synced_at),
      remotePageId: opt(r.remote_page_id),
      remoteUrl: opt(r.remote_url),
    };
  }

  saveNote(userKey: string, note: { notebook: string; section: string; title: string; body: string }, now: Date): { note: Note; created: boolean } {
    const nb = String(note.notebook || '').trim();
    const sec = String(note.section || '').trim();
    const title = String(note.title || '').trim();
    if (!nb || !title) throw new Error('notebook and title are required');
    const at = now.toISOString();
    return this.db.transaction(() => {
      const existing = this.q(
        'SELECT * FROM core_notes WHERE user_key = ? AND notebook = ? COLLATE NOCASE AND section = ? COLLATE NOCASE AND title = ? COLLATE NOCASE'
      ).get(userKey, nb, sec, title) as Row | undefined;
      if (existing) {
        this.q('UPDATE core_notes SET body = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').run(note.body, at, existing.id);
        return { note: this.noteFrom(this.q('SELECT * FROM core_notes WHERE id = ?').get(existing.id) as Row), created: false };
      }
      const id = this.q(
        'INSERT INTO core_notes (user_key, notebook, section, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(userKey, nb, sec, title, note.body, at, at).lastInsertRowid;
      return { note: this.noteFrom(this.q('SELECT * FROM core_notes WHERE id = ?').get(id) as Row), created: true };
    })();
  }

  getNote(userKey: string, id: number): Note | null {
    const r = this.q('SELECT * FROM core_notes WHERE user_key = ? AND id = ?').get(userKey, id) as Row | undefined;
    return r ? this.noteFrom(r) : null;
  }

  findNote(userKey: string, notebook: string, section: string, title: string): Note | null {
    const r = this.q(
      'SELECT * FROM core_notes WHERE user_key = ? AND notebook = ? COLLATE NOCASE AND section = ? COLLATE NOCASE AND title = ? COLLATE NOCASE'
    ).get(userKey, String(notebook || '').trim(), String(section || '').trim(), String(title || '').trim()) as Row | undefined;
    return r ? this.noteFrom(r) : null;
  }

  removeNote(userKey: string, id: number): Note | null {
    const n = this.getNote(userKey, id);
    if (!n) return null;
    this.q('DELETE FROM core_notes WHERE id = ?').run(id);
    return n;
  }

  setNoteBody(userKey: string, id: number, body: string, now: Date): Note | null {
    const info = this.q('UPDATE core_notes SET body = ?, updated_at = ?, rev = rev + 1 WHERE user_key = ? AND id = ?').run(body, now.toISOString(), userKey, id);
    return info.changes ? this.getNote(userKey, id) : null;
  }

  searchNotes(userKey: string, query: string, limit = 8): NoteHit[] {
    const cap = Math.max(1, Math.min(limit, 50));
    const toHit = (r: Row, snippet: string, score: number): NoteHit => ({
      ref: 'local:' + Number(r.id),
      path: [str(r.notebook), str(r.section), str(r.title)].filter(Boolean).join(' / '),
      snippet: snippet.slice(0, 240),
      date: str(r.updated_at).slice(0, 10) || undefined,
      score,
    });
    const expr = ftsQuery(query);
    if (expr) {
      try {
        const rows = this.q(
          `SELECT n.*, snippet(core_notes_fts, 3, '', '', '…', 32) AS snip, bm25(core_notes_fts, 2.0, 2.0, 4.0, 1.0) AS rank
           FROM core_notes_fts CROSS JOIN core_notes n ON n.id = core_notes_fts.rowid
           WHERE core_notes_fts MATCH ? AND n.user_key = ? ORDER BY rank LIMIT ?`
        ).all(expr, userKey, cap) as Row[];
        if (rows.length) return rows.map((r) => toHit(r, str(r.snip) || str(r.body), -Number(r.rank)));
      } catch {
        // fall through
      }
    }
    const tokens = likeTokens(query);
    if (!tokens.length) return [];
    return (this.q('SELECT * FROM core_notes WHERE user_key = ? ORDER BY updated_at DESC LIMIT 5000').all(userKey) as Row[])
      .map((r) => {
        const hay = [r.notebook, r.section, r.title, r.body].map(str).join(' ').toLowerCase();
        return { r, score: tokens.filter((t) => hay.includes(t)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, cap)
      .map(({ r, score }) => toHit(r, str(r.body), score));
  }

  listNotebooks(userKey: string): Array<{ notebook: string; section: string; notes: number }> {
    return (this.q(
      'SELECT notebook, section, COUNT(*) AS n FROM core_notes WHERE user_key = ? GROUP BY notebook COLLATE NOCASE, section COLLATE NOCASE ORDER BY notebook, section'
    ).all(userKey) as Row[]).map((r) => ({ notebook: str(r.notebook), section: str(r.section), notes: Number(r.n) }));
  }

  markNoteSynced(userKey: string, id: number, info: { at: Date; rev?: number; remotePageId?: string; remoteUrl?: string }): void {
    this.q(
      `UPDATE core_notes SET synced_rev = MAX(synced_rev, COALESCE(?, rev)), synced_at = ?,
       remote_page_id = COALESCE(?, remote_page_id), remote_url = COALESCE(?, remote_url) WHERE user_key = ? AND id = ?`
    ).run(info.rev ?? null, info.at.toISOString(), info.remotePageId ?? null, info.remoteUrl ?? null, userKey, id);
  }

  dirtyNotes(userKey: string): Note[] {
    return (this.q('SELECT * FROM core_notes WHERE user_key = ? AND rev > synced_rev ORDER BY id').all(userKey) as Row[]).map((r) => this.noteFrom(r));
  }

  // -------------------------------------------------------------------------
  // conversation
  // -------------------------------------------------------------------------

  private messageFrom(r: Row): StoredMessage {
    const m: StoredMessage = { id: Number(r.id), role: str(r.role) as StoredMessage['role'], content: str(r.content), at: str(r.at) };
    const calls = parseJson<ToolCall[] | null>(r.tool_calls_json, null);
    if (calls && calls.length) m.toolCalls = calls;
    if (r.tool_call_id != null) m.toolCallId = str(r.tool_call_id);
    if (r.tool_name != null) m.toolName = str(r.tool_name);
    const media = parseJson<InboundMedia[] | null>(r.media_json, null);
    if (media && media.length) m.media = media;
    if (r.origin != null) m.origin = str(r.origin);
    return m;
  }

  appendMessages(userKey: string, messages: NewMessage[]): StoredMessage[] {
    if (!messages.length) return [];
    const ins = this.q(
      'INSERT INTO core_messages (user_key, role, content, tool_calls_json, tool_call_id, tool_name, at, media_json, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const ids = this.db.transaction(() =>
      messages.map(
        (m) =>
          ins.run(
            userKey,
            m.role,
            m.content ?? '',
            m.toolCalls && m.toolCalls.length ? JSON.stringify(m.toolCalls) : null,
            m.toolCallId ?? null,
            m.toolName ?? null,
            m.at,
            m.media && m.media.length ? JSON.stringify(m.media) : null,
            m.origin ?? null
          ).lastInsertRowid
      )
    )();
    return ids.map((id) => this.messageFrom(this.q('SELECT * FROM core_messages WHERE id = ?').get(id) as Row));
  }

  messagesAfter(userKey: string, afterId: number, limit = 10_000): StoredMessage[] {
    return (this.q('SELECT * FROM core_messages WHERE user_key = ? AND id > ? ORDER BY id LIMIT ?').all(userKey, afterId, limit) as Row[]).map((r) =>
      this.messageFrom(r)
    );
  }

  recentMessages(userKey: string, limit: number): StoredMessage[] {
    return (this.q('SELECT * FROM (SELECT * FROM core_messages WHERE user_key = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(userKey, Math.max(0, limit)) as Row[]).map(
      (r) => this.messageFrom(r)
    );
  }

  messagesSince(userKey: string, sinceIso: string, limit = 5000): StoredMessage[] {
    return (this.q('SELECT * FROM core_messages WHERE user_key = ? AND at >= ? ORDER BY id LIMIT ?').all(userKey, sinceIso, limit) as Row[]).map((r) => this.messageFrom(r));
  }

  countMessages(userKey: string): number {
    return Number((this.q('SELECT COUNT(*) AS n FROM core_messages WHERE user_key = ?').get(userKey) as Row).n);
  }

  clearConversation(userKey: string): void {
    this.q('DELETE FROM core_messages WHERE user_key = ?').run(userKey);
  }

  // -------------------------------------------------------------------------
  // reminders
  // -------------------------------------------------------------------------

  private reminderFrom(r: Row): Reminder {
    const rem: Reminder = {
      id: Number(r.id),
      userKey: str(r.user_key),
      kind: str(r.kind) === 'task' ? 'task' : 'notify',
      text: str(r.text),
      fireAt: str(r.fire_at),
      status: str(r.status) as Reminder['status'],
      createdAt: str(r.created_at),
      attempts: Number(r.attempts),
    };
    const rec = parseJson<Recurrence | null>(r.recurrence_json, null);
    if (rec) rem.recurrence = rec;
    if (r.last_fired_at != null) rem.lastFiredAt = str(r.last_fired_at);
    if (r.retry_at != null) rem.retryAt = str(r.retry_at);
    return rem;
  }

  addReminder(userKey: string, r: { kind: Reminder['kind']; text: string; fireAt: Date; recurrence?: Recurrence }, now: Date): Reminder {
    const id = this.q(
      'INSERT INTO core_reminders (user_key, kind, text, fire_at, recurrence_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userKey, r.kind === 'task' ? 'task' : 'notify', r.text, r.fireAt.toISOString(), r.recurrence ? JSON.stringify(r.recurrence) : null, 'pending', now.toISOString())
      .lastInsertRowid;
    return this.reminderFrom(this.q('SELECT * FROM core_reminders WHERE id = ?').get(id) as Row);
  }

  getReminder(userKey: string, id: number): Reminder | null {
    const r = this.q('SELECT * FROM core_reminders WHERE user_key = ? AND id = ?').get(userKey, id) as Row | undefined;
    return r ? this.reminderFrom(r) : null;
  }

  listReminders(userKey: string, opts: { includeFinished?: boolean } = {}): Reminder[] {
    const sql = opts.includeFinished
      ? "SELECT * FROM core_reminders WHERE user_key = ? ORDER BY (status = 'pending') DESC, fire_at"
      : "SELECT * FROM core_reminders WHERE user_key = ? AND status = 'pending' ORDER BY fire_at";
    return (this.q(sql).all(userKey) as Row[]).map((r) => this.reminderFrom(r));
  }

  cancelReminder(userKey: string, id: number): Reminder | null {
    const info = this.q("UPDATE core_reminders SET status = 'cancelled' WHERE user_key = ? AND id = ? AND status = 'pending'").run(userKey, id);
    return info.changes ? this.getReminder(userKey, id) : null;
  }

  restoreReminder(userKey: string, id: number): Reminder | null {
    const info = this.q("UPDATE core_reminders SET status = 'pending' WHERE user_key = ? AND id = ? AND status = 'cancelled'").run(userKey, id);
    return info.changes ? this.getReminder(userKey, id) : null;
  }

  dueReminders(now: Date, limit = 50): Reminder[] {
    return (this.q(
      "SELECT * FROM core_reminders WHERE status = 'pending' AND COALESCE(retry_at, fire_at) <= ? ORDER BY COALESCE(retry_at, fire_at), id LIMIT ?"
    ).all(now.toISOString(), limit) as Row[]).map((r) =>
      this.reminderFrom(r)
    );
  }

  completeOccurrence(id: number, firedAt: Date, next: Date | null): void {
    if (next) {
      this.q('UPDATE core_reminders SET fire_at = ?, attempts = 0, retry_at = NULL, last_fired_at = ? WHERE id = ?').run(next.toISOString(), firedAt.toISOString(), id);
    } else {
      this.q("UPDATE core_reminders SET status = 'done', attempts = 0, retry_at = NULL, last_fired_at = ? WHERE id = ?").run(firedAt.toISOString(), id);
    }
  }

  deferOccurrence(id: number, retryAt: Date): void {
    this.q('UPDATE core_reminders SET attempts = attempts + 1, retry_at = ? WHERE id = ?').run(retryAt.toISOString(), id);
  }

  // -------------------------------------------------------------------------
  // conversation search
  // -------------------------------------------------------------------------

  searchMessages(userKey: string, query: string, limit = 8): Array<{ id: number; role: string; at: string; snippet: string }> {
    const expr = ftsQuery(query);
    if (!expr) return [];
    try {
      return (this.q(
        `SELECT msg_id, role, at, snippet(core_messages_fts, 0, '', '', '…', 28) AS snip, bm25(core_messages_fts) AS rank
         FROM core_messages_fts WHERE core_messages_fts MATCH ? AND user_key = ? ORDER BY rank, at DESC LIMIT ?`
      ).all(expr, userKey, Math.max(1, Math.min(limit, 30))) as Row[]).map((r) => ({ id: Number(r.msg_id), role: str(r.role), at: str(r.at), snippet: str(r.snip).slice(0, 240) }));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // secrets
  // -------------------------------------------------------------------------

  private encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.secretKey, iv);
    const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  private decrypt(blob: string): string | null {
    try {
      const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', this.secretKey, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  setSecret(userKey: string, name: string, value: string, hosts: string[], now: Date): void {
    this.q(
      `INSERT INTO core_secrets (user_key, name, value_enc, hosts_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_key, name) DO UPDATE SET value_enc = excluded.value_enc, hosts_json = excluded.hosts_json, updated_at = excluded.updated_at`
    ).run(userKey, name, this.encrypt(value), JSON.stringify([...new Set(hosts.map((h) => h.toLowerCase()))]), now.toISOString());
  }

  getSecret(userKey: string, name: string): { value: string; hosts: string[] } | null {
    const r = this.q('SELECT value_enc, hosts_json FROM core_secrets WHERE user_key = ? AND name = ?').get(userKey, name) as Row | undefined;
    if (!r) return null;
    const value = this.decrypt(str(r.value_enc));
    return value === null ? null : { value, hosts: parseJson<string[]>(r.hosts_json, []) };
  }

  listSecrets(userKey: string): Array<{ name: string; hosts: string[]; updatedAt: string }> {
    return (this.q('SELECT name, hosts_json, updated_at FROM core_secrets WHERE user_key = ? ORDER BY name').all(userKey) as Row[]).map((r) => ({
      name: str(r.name),
      hosts: parseJson<string[]>(r.hosts_json, []),
      updatedAt: str(r.updated_at),
    }));
  }

  allowSecretHost(userKey: string, name: string, host: string): void {
    const r = this.q('SELECT hosts_json FROM core_secrets WHERE user_key = ? AND name = ?').get(userKey, name) as Row | undefined;
    if (!r) return;
    const hosts = new Set(parseJson<string[]>(r.hosts_json, []));
    hosts.add(host.toLowerCase());
    this.q('UPDATE core_secrets SET hosts_json = ? WHERE user_key = ? AND name = ?').run(JSON.stringify([...hosts]), userKey, name);
  }

  removeSecret(userKey: string, name: string): boolean {
    return this.q('DELETE FROM core_secrets WHERE user_key = ? AND name = ?').run(userKey, name).changes > 0;
  }

  // -------------------------------------------------------------------------
  // turn log
  // -------------------------------------------------------------------------

  recordTurn(t: Omit<TurnRecord, 'id' | 'feedback' | 'feedbackScore'>): number {
    const info = this.q(
      `INSERT INTO core_turns (user_key, at, kind, ms, rounds, tools_json, corrections_json, effects_json, degraded, silent, model,
        prompt_tokens, completion_tokens, cached_tokens, reply_chars, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      t.userKey,
      t.at,
      t.kind,
      Math.round(t.ms),
      t.rounds,
      JSON.stringify(t.tools),
      JSON.stringify(t.corrections),
      JSON.stringify(t.effects),
      t.degraded ?? null,
      t.silent ? 1 : 0,
      t.model ?? null,
      t.promptTokens,
      t.completionTokens,
      t.cachedTokens,
      t.replyChars,
      t.error ?? null
    );
    return Number(info.lastInsertRowid);
  }

  attachTurnMessages(turnId: number, messageIds: number[]): void {
    if (messageIds.length) this.q('UPDATE core_turns SET message_ids_json = ? WHERE id = ?').run(JSON.stringify(messageIds), turnId);
  }

  turnForMessage(userKey: string, messageId: number): { id: number; at: string } | null {
    const rows = this.q('SELECT id, at, message_ids_json FROM core_turns WHERE user_key = ? AND message_ids_json IS NOT NULL ORDER BY id DESC LIMIT 200').all(userKey) as Row[];
    for (const r of rows) if (parseJson<number[]>(r.message_ids_json, []).includes(messageId)) return { id: Number(r.id), at: str(r.at) };
    return null;
  }

  setTurnFeedback(turnId: number, emoji: string, score: number, at: Date): void {
    this.q('UPDATE core_turns SET feedback = ?, feedback_score = ?, feedback_at = ? WHERE id = ?').run(emoji || null, emoji ? score : null, at.toISOString(), turnId);
  }

  addIssue(userKey: string, kind: string, text: string, at: Date, turnId?: number): number {
    const info = this.q('INSERT INTO core_issues (user_key, at, turn_id, kind, text) VALUES (?, ?, ?, ?, ?)').run(userKey, at.toISOString(), turnId ?? null, kind, text.slice(0, 1000));
    return Number(info.lastInsertRowid);
  }

  turnsSince(sinceIso: string, userKey?: string): TurnRecord[] {
    const rows = (
      userKey
        ? this.q('SELECT * FROM core_turns WHERE at >= ? AND user_key = ? ORDER BY id').all(sinceIso, userKey)
        : this.q('SELECT * FROM core_turns WHERE at >= ? ORDER BY id').all(sinceIso)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      userKey: str(r.user_key),
      at: str(r.at),
      kind: str(r.kind),
      ms: Number(r.ms),
      rounds: Number(r.rounds),
      tools: parseJson<TurnToolLog[]>(r.tools_json, []),
      corrections: parseJson<string[]>(r.corrections_json, []),
      effects: parseJson<string[]>(r.effects_json, []),
      degraded: opt(r.degraded),
      silent: Number(r.silent) === 1,
      model: opt(r.model),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      cachedTokens: Number(r.cached_tokens),
      replyChars: Number(r.reply_chars),
      error: opt(r.error),
      feedback: opt(r.feedback),
      feedbackScore: r.feedback_score == null ? undefined : Number(r.feedback_score),
    }));
  }

  issuesSince(sinceIso: string, userKey?: string): IssueRecord[] {
    const rows = (
      userKey
        ? this.q('SELECT * FROM core_issues WHERE at >= ? AND user_key = ? ORDER BY id').all(sinceIso, userKey)
        : this.q('SELECT * FROM core_issues WHERE at >= ? ORDER BY id').all(sinceIso)
    ) as Row[];
    return rows.map((r) => ({ id: Number(r.id), userKey: str(r.user_key), at: str(r.at), turnId: r.turn_id == null ? undefined : Number(r.turn_id), kind: str(r.kind), text: str(r.text) }));
  }

  pruneLogs(beforeIso: string): number {
    const a = this.q('DELETE FROM core_turns WHERE at < ?').run(beforeIso).changes;
    const b = this.q('DELETE FROM core_issues WHERE at < ?').run(beforeIso).changes;
    return a + b;
  }

  // -------------------------------------------------------------------------
  // wipe
  // -------------------------------------------------------------------------

  wipeUser(userKey: string, scope: 'chat' | 'memory' | 'all'): void {
    this.db.transaction(() => {
      this.q('DELETE FROM core_messages WHERE user_key = ?').run(userKey);
      if (scope === 'chat') {
        const st = this.getState(userKey);
        st.summary = '';
        st.summaryThrough = 0;
        st.cited = [];
        st.pendingOffer = undefined;
        st.approvals = [];
        this.saveState(userKey, st);
        return;
      }
      this.q('DELETE FROM core_facts WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_skills WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_profile WHERE user_key = ?').run(userKey);
      const st = this.getState(userKey);
      const kept = { importedLegacyAt: st.importedLegacyAt, importedLegacyDbAt: st.importedLegacyDbAt, usage: st.usage, turnCount: 0 };
      this.q('DELETE FROM core_state WHERE user_key = ?').run(userKey);
      if (scope === 'memory') {
        this.saveState(userKey, { ...this.getState(userKey), ...kept, journalOpen: st.journalOpen, journalDate: st.journalDate, journalOpenedAt: st.journalOpenedAt });
        return;
      }
      this.q('DELETE FROM core_journal_entries WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_journal_days WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_notes WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_reminders WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_secrets WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_turns WHERE user_key = ?').run(userKey);
      this.q('DELETE FROM core_issues WHERE user_key = ?').run(userKey);
      this.saveState(userKey, { ...this.getState(userKey), ...kept });
    })();
  }

  listUserKeys(): string[] {
    return (this.q(
      `SELECT user_key FROM core_profile UNION SELECT user_key FROM core_state UNION SELECT user_key FROM core_messages
       UNION SELECT user_key FROM core_journal_days UNION SELECT user_key FROM core_reminders ORDER BY user_key`
    ).all() as Row[]).map((r) => str(r.user_key));
  }
}
