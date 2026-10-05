/**
 * Summary of the turn log from a database file, for working on the app offline.
 *   npm run insights -- [hours] [path/to/i-journal.db]
 */
import Database from 'better-sqlite3';
import { summarize } from '../core/insights';
import { SqliteStore } from '../core/store';

const hours = Number(process.argv[2]) || 24;
const file = process.argv[3] || process.env.DB_PATH || 'data/i-journal.db';
const store = new SqliteStore(new Database(file, { fileMustExist: true }));
const since = new Date(Date.now() - hours * 3_600_000);
const text = summarize(store.turnsSince(since.toISOString()), store.issuesSince(since.toISOString()), { since, scope: file, viewer: process.env.TELEGRAM_OWNER_ID });
console.log(text.replace(/\*/g, ''));
