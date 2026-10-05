import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPersonRuntime } from '../../src/bot/person/runtime';
import { summarize, reactionScore } from '../../src/core/insights';
import { createLogger, redact } from '../../src/core/log';
import { runMigrations } from '../../src/db';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

test('logs never carry secrets: credential fields and token-shaped strings are masked', () => {
  const lines: string[] = [];
  const log = createLogger({ json: true, write: (_l, line) => lines.push(line), base: { app: 'x' } });
  // Telegram's documentation example token, assembled so secret scanners don't flag the source.
  const exampleToken = ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'].join(':');
  log.info(`calling https://api.telegram.org/bot${exampleToken}/getMe`, {
    apiKey: 'sk-live-should-not-show',
    client_secret: 'abc',
    promptTokens: 1234,
    nested: { refreshToken: 'r', note: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop' },
    deepseek: 'key is sk-abcdefghijklmnopqrstuvwxyz123456',
  });
  const row = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(row.app, 'x');
  assert.equal(row.level, 'info');
  assert.match(String(row.msg), /bot\[redacted\]|\[redacted\]/);
  assert.doesNotMatch(lines[0], /AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ|sk-live|sk-abcdef|eyJhbGci/);
  assert.equal(row.apiKey, '[redacted]');
  assert.equal(row.client_secret, '[redacted]');
  assert.equal(row.promptTokens, 1234, 'token counts are not secrets');
  assert.deepEqual(row.nested, { refreshToken: '[redacted]', note: 'Bearer [redacted]' });
  assert.equal(redact('gsk_abcdefghijklmnopqrstuvwx'), '[redacted]');

  const pretty: string[] = [];
  createLogger({ json: false, write: (_l, line) => pretty.push(line), scope: 'core' }).warn('slow', { ms: 9000 });
  assert.match(pretty[0], /^\d\d:\d\d:\d\d ! \[core\] slow \{"ms":9000\}$/);
});

test('the model switches on when the owner adds a DeepSeek key with /key, without a restart', () => {
  const db = new Database(':memory:');
  const env = { TELEGRAM_OWNER_ID: '100000001', TELEGRAM_BOT_TOKEN: 'test' } as NodeJS.ProcessEnv;
  const rt = createPersonRuntime(db, { env, log: quiet });
  assert.deepEqual(rt.providers(), []);
  rt.store.setSecret('100000001', 'DEEPSEEK_API_KEY', 'sk-test-key-value-1234567890', ['api.deepseek.com'], new Date());
  rt.refreshPorts();
  assert.deepEqual(rt.providers(), ['deepseek:deepseek-chat']);
  assert.equal(rt.core.deps.model.supportsImages(), true);
  rt.store.setSecret('200000002', 'OPENROUTER_API_KEY', 'sk-other-person-key-123456', [], new Date());
  rt.refreshPorts();
  assert.deepEqual(rt.providers(), ['deepseek:deepseek-chat'], "only the owner's keys count");
});

test('startup imports the original companion tables once and reports it', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const t = '2026-09-01T00:00:00Z';
  db.prepare('INSERT INTO users (telegram_id, is_owner, onboarding_complete, created_at, updated_at) VALUES (?, 1, 1, ?, ?)').run('100000001', t, t);
  db.prepare('INSERT INTO journal_entries (user_id, entry_date, day_of_week, session_type, content_markdown, saved_to_cloud, created_at) VALUES (1, ?, ?, ?, ?, 0, ?)').run('2026-09-20', 'Sunday', 'evening', 'Quiet day.', t);
  const rt = createPersonRuntime(db, { env: { TELEGRAM_BOT_TOKEN: 'test' } as NodeJS.ProcessEnv, log: quiet });
  assert.equal(rt.imported.length, 1);
  assert.equal(rt.imported[0].entries, 1);
  assert.equal(rt.store.getDay('100000001', '2026-09-20')?.entries[0].text, 'Quiet day.');
  const again = createPersonRuntime(db, { env: { TELEGRAM_BOT_TOKEN: 'test' } as NodeJS.ProcessEnv, log: quiet });
  assert.deepEqual(again.imported, []);
});

test('insights read the turn log: speed, failures, corrections, reactions', () => {
  const base = { userKey: 'a', kind: 'message', rounds: 1, effects: [], silent: false, model: 'deepseek:deepseek-chat', promptTokens: 1000, completionTokens: 100, cachedTokens: 800, replyChars: 50 };
  const turns = [
    { ...base, id: 1, at: '2026-10-05T10:00:00Z', ms: 1200, tools: [{ tool: 'web_search', ok: true, ms: 800 }], corrections: [] },
    { ...base, id: 2, at: '2026-10-05T10:05:00Z', ms: 9800, tools: [{ tool: 'notes_search', ok: false, ms: 5000, error: 'OneNote said 503' }], corrections: ['claim'], feedback: '👎', feedbackScore: -1 },
    { ...base, id: 3, at: '2026-10-05T10:06:00Z', ms: 900, tools: [], corrections: [], degraded: 'timeout', feedback: '❤', feedbackScore: 1 },
  ];
  const text = summarize(turns, [{ id: 1, userKey: 'a', at: '2026-10-05T10:05:00Z', kind: 'tool_failed', text: 'OneNote search kept failing.' }], { since: new Date('2026-10-05T00:00:00Z') });
  const plain = text.replace(/\*/g, '');
  assert.match(plain, /Turns: 3 \(3 message\) from 1 person/);
  assert.match(plain, /median 1\.2s, 95% under 9\.8s, slowest 9\.8s \(turn #2, notes_search\)/);
  assert.match(plain, /80% of input cached/);
  assert.match(plain, /Problems: timeout ×1/);
  assert.match(plain, /Tool failures: 1 — notes_search ×1/);
  assert.match(plain, /Self-corrections: claim ×1/);
  assert.match(plain, /Reactions: 👍 1, 👎 1/);
  assert.match(plain, /\[tool_failed\] OneNote search kept failing\./);
  assert.equal(reactionScore('👍'), 1);
  assert.equal(reactionScore('🤔'), 0);
  assert.equal(reactionScore('👎'), -1);
});
