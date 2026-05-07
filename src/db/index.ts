import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DEFAULT_DB_PATH = path.join(__dirname, '../../data/i-journal.db');

let dbInstance: Database.Database | null = null;

function resolveDbPath(): string {
  const explicitPath = process.env.DB_PATH;
  if (explicitPath) return explicitPath;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Production requires DB_PATH to point at persistent storage. On Railway, mount a volume and set DB_PATH=/data/i-journal.db.'
    );
  }

  return DEFAULT_DB_PATH;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = resolveDbPath();
  ensureParentDir(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);
  dbInstance = db;
  console.log(`[DB] Connected at ${dbPath}`);
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;

  for (const { version, up } of MIGRATIONS) {
    if (version <= current) continue;
    console.log(`[DB] Applying migration ${version}...`);
    const tx = db.transaction(() => {
      up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString()
      );
    });
    tx();
  }
}

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id TEXT NOT NULL UNIQUE,
          username TEXT,
          first_name TEXT,
          is_owner INTEGER NOT NULL DEFAULT 0,
          onboarding_complete INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE profiles (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sections_json TEXT NOT NULL,
          schedule_json TEXT NOT NULL,
          morning_time TEXT NOT NULL,
          evening_time TEXT NOT NULL,
          timezone TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_review_date TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE journal_state (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          last_morning_date TEXT,
          last_evening_date TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          session_type TEXT NOT NULL,
          started_at TEXT NOT NULL,
          target_date TEXT,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE journal_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          entry_date TEXT NOT NULL,
          day_of_week TEXT NOT NULL,
          session_type TEXT NOT NULL,
          content_markdown TEXT NOT NULL,
          onenote_url TEXT,
          saved_to_cloud INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          UNIQUE(user_id, entry_date, session_type)
        );

        CREATE INDEX idx_journal_entries_user_date ON journal_entries(user_id, entry_date DESC);

        CREATE TABLE storage_connections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          access_token TEXT,
          refresh_token TEXT,
          expires_at TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, provider)
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE pending_reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          fire_at TEXT NOT NULL,
          payload_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_pending_reminders_fire_at ON pending_reminders(fire_at);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE routines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          schedule_json TEXT NOT NULL,
          config_json TEXT,
          next_run_at TEXT NOT NULL,
          last_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX idx_routines_due ON routines(enabled, next_run_at);
        CREATE INDEX idx_routines_user_kind ON routines(user_id, kind);

        CREATE TABLE routine_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          output_summary TEXT,
          error TEXT
        );

        CREATE INDEX idx_routine_runs_routine_started ON routine_runs(routine_id, started_at DESC);
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE agent_workspace_docs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          doc_key TEXT NOT NULL,
          content_markdown TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, doc_key)
        );

        CREATE INDEX idx_agent_workspace_docs_user ON agent_workspace_docs(user_id);
      `);
    },
  },
];
