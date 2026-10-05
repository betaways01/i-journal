/**
 * The development loop end to end: every turn lands in the turn log, reactions become feedback (and
 * the companion sees them), the companion's own issue reports are kept, and the owner can read it all
 * with /debug and /export. Also: the owner is told how to switch the model on when it has no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Telegraf } from 'telegraf';
import { allowListFromEnv, registerPersonBot } from '../../src/bot/person/gateway';
import { enqueueUserTurn } from '../../src/bot/queue';
import { createCore, createModelClient, SqliteStore } from '../../src/core';
import { lastUserText, ScriptedModel, ScriptEntry } from '../../src/core/testing/scriptedModel';
import { Logger, ModelClient } from '../../src/core/types';
import { FakeTelegram } from '../support/fakeTelegram';

const OWNER = 100000001;
const SECOND = 6000000001;

async function boot(steps: ScriptEntry[] | null) {
  const fake = await FakeTelegram.start();
  const store = new SqliteStore(new Database(':memory:'));
  const model: ModelClient = steps ? new ScriptedModel(steps) : createModelClient({ providers: [] });
  const log: Logger = { info() {}, warn() {}, error() {} };
  const core = createCore({ store, model, ports: {}, log });
  const bot = new Telegraf(fake.token, { telegram: { apiRoot: fake.apiRoot } });
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-obs-'));
  registerPersonBot(bot, {
    core,
    enqueue: (u, job) => enqueueUserTurn(u, job),
    mediaDir,
    defaultTimezone: 'Asia/Riyadh',
    allow: allowListFromEnv({ TELEGRAM_OWNER_ID: String(OWNER), TELEGRAM_ALLOWED_IDS: String(SECOND) }),
    log,
    typingIntervalMs: 40,
    stream: false,
    isOwner: (k) => k === String(OWNER),
    modelReady: () => Boolean(steps),
  });
  await new Promise<void>((resolve) => void bot.launch({}, resolve).catch(() => undefined));
  return {
    fake,
    store,
    model,
    close: async () => {
      bot.stop('test');
      await fake.stop();
      fs.rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}

test('turns are logged with tools and model; a 👎 reaction is recorded and shown to the companion next turn', async () => {
  const b = await boot([
    { toolCalls: [{ name: 'remind_set', args: { text: 'Stretch', in_minutes: 30 } }] },
    { text: 'Set for half an hour from now.' },
    { text: 'Understood.' },
  ]);
  try {
    b.fake.sendText(OWNER, 'remind me in 30 minutes to stretch');
    await b.fake.waitForBotMessages(OWNER, 1);
    await b.fake.waitFor(() => b.store.turnsSince('2000-01-01').length === 1 && Boolean(b.store.turnForMessage(String(OWNER), b.fake.botMessages(OWNER)[0].message_id)));
    const [turn] = b.store.turnsSince('2000-01-01');
    assert.equal(turn.kind, 'message');
    assert.equal(turn.rounds, 1);
    assert.deepEqual(turn.tools.map((t) => [t.tool, t.ok]), [['remind_set', true]]);
    assert.deepEqual(turn.effects, ['reminder_set']);
    assert.equal(turn.model, 'scripted:scripted');
    assert.equal(turn.replyChars, 'Set for half an hour from now.'.length);

    const reply = b.fake.botMessages(OWNER)[0];
    b.fake.react(OWNER, reply.message_id, '👎');
    await b.fake.waitFor(() => b.store.turnsSince('2000-01-01')[0].feedback === '👎');
    assert.equal(b.store.turnsSince('2000-01-01')[0].feedbackScore, -1);

    b.fake.sendText(OWNER, 'ok');
    await b.fake.waitForBotMessages(OWNER, 2);
    const ctx = lastUserText((b.model as ScriptedModel).calls.at(-1)!);
    assert.match(ctx, /they reacted 👎 to your message "Set for half an hour from now\." — they did not like it/);
    await b.fake.waitFor(() => b.store.turnsSince('2000-01-01').length === 2);
    b.fake.sendText(OWNER, 'again');
    await b.fake.waitForBotMessages(OWNER, 3);
    assert.doesNotMatch(lastUserText((b.model as ScriptedModel).calls.at(-1)!), /reacted/, 'shown once');
  } finally {
    await b.close();
  }
});

test('issues the companion reports are kept; /debug shows them to the owner only; /export sends a private file', async () => {
  const b = await boot([
    { toolCalls: [{ name: 'report_issue', args: { kind: 'missing_capability', text: 'Wanted the journal emailed weekly; no email tool.' } }] },
    { text: "I can't email yet, but I can send you a weekly summary here." },
    { toolCalls: [{ name: 'report_issue', args: { kind: 'complaint', text: 'Second person found replies too long.' } }] },
    { text: 'Got it.' },
  ]);
  try {
    b.fake.sendText(OWNER, 'email me my journal every sunday');
    await b.fake.waitForBotMessages(OWNER, 1);
    assert.doesNotMatch(b.fake.lastBotText(OWNER)!, /developer|report/i);
    b.fake.sendText(SECOND, 'your replies are too long');
    await b.fake.waitForBotMessages(SECOND, 1);
    await b.fake.waitFor(() => b.store.issuesSince('2000-01-01').length === 2);
    const [i1] = b.store.issuesSince('2000-01-01');
    assert.equal(i1.kind, 'missing_capability');
    assert.equal(i1.userKey, String(OWNER));
    assert.ok(i1.turnId);

    b.fake.sendCommand(SECOND, '/debug');
    await b.fake.waitForBotMessages(SECOND, 2);
    assert.match(b.fake.lastBotText(SECOND)!, /for the owner/);

    b.fake.sendCommand(OWNER, '/debug');
    await b.fake.waitForBotMessages(OWNER, 2);
    const dbg = b.fake.lastBotText(OWNER)!;
    assert.match(dbg, /Turns: 2 \(2 message\) from 2 people/);
    assert.match(dbg, /\[missing_capability\] Wanted the journal emailed weekly/);
    assert.doesNotMatch(dbg, /too long/, "another person's words are not shown");
    assert.match(dbg, /1 from other people \(complaint ×1\)/);

    b.fake.sendCommand(OWNER, '/export 7');
    await b.fake.waitFor(() => b.fake.botMessages(OWNER).some((m) => m.document));
    const doc = b.fake.botMessages(OWNER).find((m) => m.document)!.document!;
    assert.match(doc.fileName, /^i-journal-turns-\d{4}-\d{2}-\d{2}-7d\.jsonl$/);
    const rows = doc.content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(rows[0].type, 'export');
    const turns = rows.filter((r) => r.type === 'turn');
    assert.equal(turns.length, 2);
    assert.ok(turns.some((t) => t.userKey === String(OWNER)));
    assert.ok(turns.some((t) => /^person-[0-9a-f]{8}$/.test(String(t.userKey))), 'the other person is pseudonymous');
    const messages = rows.filter((r) => r.type === 'message');
    assert.ok(messages.some((m) => m.content === 'email me my journal every sunday'), 'owner transcript included');
    assert.ok(!messages.some((m) => m.content === 'your replies are too long'), "nobody else's words");
    assert.ok(rows.some((r) => r.type === 'issue' && r.text === '(private)'));
  } finally {
    await b.close();
  }
});

test('with no model key, the owner gets exact setup steps and others just an honest line', async () => {
  const b = await boot(null);
  try {
    b.fake.sendText(OWNER, 'hello?');
    await b.fake.waitForBotMessages(OWNER, 1);
    const owner = b.fake.lastBotText(OWNER)!;
    assert.match(owner, /not fully switched on yet: the server has no AI model key/);
    assert.match(owner, /\/key DEEPSEEK_API_KEY your-key/);
    assert.match(owner, /Railway → Variables/);
    b.fake.sendText(SECOND, 'hello?');
    await b.fake.waitForBotMessages(SECOND, 1);
    assert.match(b.fake.lastBotText(SECOND)!, /not fully switched on yet/);
    assert.doesNotMatch(b.fake.lastBotText(SECOND)!, /\/key/);
    await b.fake.waitFor(() => b.store.turnsSince('2000-01-01').length === 2);
    assert.deepEqual(b.store.turnsSince('2000-01-01').map((t) => t.degraded), ['not_configured', 'not_configured']);
  } finally {
    await b.close();
  }
});
