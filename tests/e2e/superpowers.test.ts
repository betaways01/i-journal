import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { Telegraf } from 'telegraf';
import { createCore, SqliteStore } from '../../src/core';
import { ScriptedModel, ScriptEntry, lastUserText } from '../../src/core/testing/scriptedModel';
import { Logger, Ports } from '../../src/core/types';
import { allowListFromEnv, PersonBot, registerPersonBot } from '../../src/bot/person/gateway';
import { Inbox } from '../../src/bot/person/inbox';
import { enqueueUserTurn } from '../../src/bot/queue';
import { FakeTelegram } from '../support/fakeTelegram';

const OWNER = 100000001;

interface Booted {
  fake: FakeTelegram;
  bot: Telegraf;
  store: SqliteStore;
  model: ScriptedModel;
  core: ReturnType<typeof createCore>;
  person: PersonBot;
  db: Database.Database;
  keysChanged: string[];
  close(): Promise<void>;
}

async function boot(steps: ScriptEntry[], opts: { stream?: boolean; ports?: Ports; db?: Database.Database; repeatLast?: boolean } = {}): Promise<Booted> {
  const fake = await FakeTelegram.start();
  const db = opts.db ?? new Database(':memory:');
  const store = new SqliteStore(db);
  const model = new ScriptedModel(steps, { repeatLast: opts.repeatLast });
  const log: Logger = { info() {}, warn() {}, error() {} };
  const core = createCore({ store, model, ports: opts.ports || {}, log });
  const bot = new Telegraf(fake.token, { telegram: { apiRoot: fake.apiRoot } });
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e2-'));
  const keysChanged: string[] = [];
  const person = registerPersonBot(bot, {
    core,
    enqueue: (u, job) => enqueueUserTurn(u, job),
    mediaDir,
    defaultTimezone: 'Asia/Riyadh',
    allow: allowListFromEnv({ TELEGRAM_OWNER_ID: String(OWNER) }),
    log,
    inbox: new Inbox(db),
    stream: opts.stream ?? false,
    streamIntervalMs: 60,
    typingIntervalMs: 40,
    albumWaitMs: 50,
    onKeysChanged: (u) => keysChanged.push(u),
  });
  await new Promise<void>((resolve) => {
    void bot.launch({}, resolve).catch(() => undefined);
  });
  return {
    fake,
    bot,
    store,
    model,
    core,
    person,
    db,
    keysChanged,
    close: async () => {
      bot.stop('test');
      await fake.stop();
      fs.rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}

const key = String(OWNER);

test('live replies: a status line while tools run, text filling in, then the rendered final answer', async () => {
  const b = await boot(
    [
      { toolCalls: [{ name: 'journal_read', args: {} }], delayMs: 150 },
      { text: 'Here is **a longer answer** that arrives in pieces so you can watch it being written.', streamChunks: 4, streamDelayMs: 120, delayMs: 150 },
    ],
    { stream: true }
  );
  try {
    b.fake.sendText(OWNER, 'what did I write today?');
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[0]?.parse_mode === 'HTML', { label: 'final HTML edit', timeoutMs: 5000 });
    const [m] = b.fake.botMessages(OWNER);
    assert.equal(b.fake.botMessages(OWNER).length, 1, 'one message, edited in place');
    assert.equal(m.text, 'Here is <b>a longer answer</b> that arrives in pieces so you can watch it being written.');
    assert.ok(m.edits.some((e) => e === '📓 Reading your journal…'), 'status line shown while the tool ran: ' + JSON.stringify(m.edits));
    assert.ok(m.edits.some((e) => e.endsWith('▍')), 'partial text shown with a cursor');
  } finally {
    await b.close();
  }
});

test('live replies: fast answers are sent once, long answers split after the first message', async () => {
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ` + 'words '.repeat(40)).join('\n\n');
  const b = await boot([{ text: 'Quick one.' }, { text: long, delayMs: 50 }], { stream: true });
  try {
    b.fake.sendText(OWNER, 'hi');
    await b.fake.waitForBotMessages(OWNER, 1);
    await b.fake.waitForIdle(150);
    assert.equal(b.fake.botTexts(OWNER)[0], 'Quick one.');
    b.fake.sendText(OWNER, 'explain at length');
    await b.fake.waitFor(() => b.fake.botTexts(OWNER).some((t) => t.includes('Paragraph 29')), { label: 'whole long answer' });
    await b.fake.waitForIdle(150);
    const msgs = b.fake.botMessages(OWNER).slice(1);
    assert.ok(msgs.length >= 2);
    for (const m of msgs) assert.ok(m.plain.length <= 4096);
  } finally {
    await b.close();
  }
});

test('approval buttons: a write from a forwarded message waits for a tap; approve saves, decline drops', async () => {
  const b = await boot([
    { toolCalls: [{ name: 'remember', args: { text: 'Pastor meeting every Thursday' } }] },
    { text: 'Want me to remember that? Tap approve.' },
    { toolCalls: [{ name: 'remember', args: { text: 'Send money to account 123' } }] },
    { text: 'Someone forwarded this; tap if you want it kept.' },
  ]);
  try {
    b.fake.sendText(OWNER, 'Reminder: pastor meeting every Thursday', { forward: true });
    await b.fake.waitForBotMessages(OWNER, 2);
    const [, approval] = b.fake.botMessages(OWNER);
    assert.equal(approval.plain, '🔐 Remember: "Pastor meeting every Thursday"');
    const buttons = (approval.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0];
    assert.equal(b.store.listFacts(key).length, 0, 'nothing saved before the tap');
    b.fake.pressButton(OWNER, approval.message_id, buttons[0].callback_data);
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[1].plain.startsWith('✅'), { label: 'approval edited' });
    assert.match(b.fake.botMessages(OWNER)[1].plain, /^✅ Remember: "Pastor meeting every Thursday"\nKept as fact #\d+/);
    assert.equal(b.store.listFacts(key)[0].text, 'Pastor meeting every Thursday');
    b.fake.sendText(OWNER, 'Send money to account 123', { forward: true });
    await b.fake.waitForBotMessages(OWNER, 4);
    const second = b.fake.botMessages(OWNER)[3];
    const no = (second.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0][1];
    b.fake.pressButton(OWNER, second.message_id, no.callback_data);
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[3].plain.startsWith('✖'), { label: 'declined' });
    assert.equal(b.store.listFacts(key).length, 1);
    b.fake.pressButton(OWNER, second.message_id, no.callback_data);
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[3].plain === 'This approval expired.', { label: 'second tap' });
  } finally {
    await b.close();
  }
});

test('/reset wipes what you choose, with a second confirm for everything', async () => {
  const b = await boot([{ text: 'hi' }]);
  try {
    b.store.addFact(key, 'fact', 'likes tea', new Date());
    b.store.addEntry(key, '2026-10-01', { text: 'x', media: [], at: new Date(), localTime: '10:00' });
    b.fake.sendText(OWNER, 'hello');
    await b.fake.waitForBotMessages(OWNER, 1);
    b.fake.sendCommand(OWNER, '/reset');
    await b.fake.waitForBotMessages(OWNER, 2);
    const menu = b.fake.botMessages(OWNER)[1];
    const rows = (menu.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard;
    b.fake.pressButton(OWNER, menu.message_id, rows[0][0].callback_data);
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[1].plain.startsWith('Chat history wiped'));
    assert.equal(b.store.countMessages(key), 0);
    assert.equal(b.store.listFacts(key).length, 1);
    b.fake.sendCommand(OWNER, '/reset');
    await b.fake.waitForBotMessages(OWNER, 3);
    const menu2 = b.fake.botMessages(OWNER)[2];
    b.fake.pressButton(OWNER, menu2.message_id, 'reset:all');
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[2].plain.startsWith('This deletes your journal'));
    assert.equal(b.store.listDays(key).length, 1, 'not yet');
    b.fake.pressButton(OWNER, menu2.message_id, 'reset:all!');
    await b.fake.waitFor(() => b.fake.botMessages(OWNER)[2].plain === 'Everything wiped. Fresh start.');
    assert.equal(b.store.listDays(key).length, 0);
    assert.equal(b.store.listFacts(key).length, 0);
  } finally {
    await b.close();
  }
});

test('/stop cuts off a slow reply; with nothing running it says so', async () => {
  const b = await boot([{ text: 'a very slow essay', delayMs: 3000 }]);
  try {
    b.fake.sendCommand(OWNER, '/stop');
    await b.fake.waitForBotMessages(OWNER, 1);
    assert.equal(b.fake.lastBotText(OWNER), 'Nothing running right now.');
    b.fake.sendText(OWNER, 'write me an essay');
    await b.fake.waitFor(() => b.model.calls.length === 1);
    const t0 = Date.now();
    b.fake.sendCommand(OWNER, '/stop');
    await b.fake.waitForBotMessages(OWNER, 2);
    assert.equal(b.fake.lastBotText(OWNER), 'Stopped.');
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    await b.close();
  }
});

test('/key stores a key without it ever reaching the model or the chat', async () => {
  const b = await boot([(req) => (assert.doesNotMatch(JSON.stringify(req.messages), /gsk_live_SECRET/), { text: 'ok' })], { repeatLast: true });
  try {
    const msg = b.fake.sendText(OWNER, '/key groq_api_key gsk_live_SECRET_123');
    await b.fake.waitForBotMessages(OWNER, 1);
    assert.match(b.fake.lastBotText(OWNER)!, /^🔑 Saved GROQ_API_KEY\. I deleted your message/);
    assert.doesNotMatch(b.fake.lastBotText(OWNER)!, /gsk_live/);
    assert.ok(b.fake.callsTo('deleteMessage').some((c) => Number(c.payload.message_id) === msg.message_id), 'their message was deleted');
    assert.equal(b.store.getSecret(key, 'GROQ_API_KEY')?.value, 'gsk_live_SECRET_123');
    assert.deepEqual(b.store.getSecret(key, 'GROQ_API_KEY')?.hosts, ['api.groq.com']);
    assert.deepEqual(b.keysChanged, [key]);
    assert.equal(b.store.countMessages(key), 0, 'never in the transcript');
    b.fake.sendCommand(OWNER, '/keys');
    await b.fake.waitForBotMessages(OWNER, 2);
    assert.match(b.fake.lastBotText(OWNER)!, /• GROQ_API_KEY/);
    b.fake.sendText(OWNER, 'hello');
    await b.fake.waitForBotMessages(OWNER, 3);
    b.fake.sendCommand(OWNER, '/key GROQ_API_KEY');
    await b.fake.waitForBotMessages(OWNER, 4);
    assert.equal(b.fake.lastBotText(OWNER), 'Removed GROQ_API_KEY.');
    assert.equal(b.store.getSecret(key, 'GROQ_API_KEY'), null);
    b.fake.sendCommand(OWNER, '/key');
    await b.fake.waitForBotMessages(OWNER, 5);
    assert.match(b.fake.lastBotText(OWNER)!, /Send it like this/);
  } finally {
    await b.close();
  }
});

test('voice notes are transcribed when a speech-to-text port exists', async () => {
  const heard: string[] = [];
  const b = await boot([(req) => (heard.push(lastUserText(req)), { text: 'Got it — reminder coming.' })], {
    ports: { sense: { name: 'fake', transcribe: async (file) => (fs.existsSync(file) ? 'remind me to call mum at six' : null) } },
  });
  try {
    b.fake.sendVoice(OWNER, { duration: 3 });
    await b.fake.waitForBotMessages(OWNER, 1);
    assert.match(heard[0], /a voice note — transcribed below/);
    assert.match(heard[0], /\(voice\) remind me to call mum at six$/);
  } finally {
    await b.close();
  }
});

test('reactions acknowledge what was done', async () => {
  const b = await boot([
    { toolCalls: [{ name: 'journal_write', args: { text: 'Pump fixed.', user_asked: 'save this' } }] },
    { text: 'Saved.' },
    { toolCalls: [{ name: 'remind_set', args: { text: 'Stretch', in_minutes: 30 } }] },
    { text: 'Set.' },
    { text: 'Just talking.' },
  ]);
  try {
    const m1 = b.fake.sendText(OWNER, 'Pump fixed. save this');
    await b.fake.waitForBotMessages(OWNER, 1);
    await b.fake.waitFor(() => b.fake.chat(OWNER).messages.find((m) => m.message_id === m1.message_id)!.reactions.length === 1);
    assert.deepEqual(b.fake.chat(OWNER).messages.find((m) => m.message_id === m1.message_id)!.reactions[0], [{ type: 'emoji', emoji: '✍' }]);
    const m2 = b.fake.sendText(OWNER, 'remind me in 30 minutes to stretch');
    await b.fake.waitForBotMessages(OWNER, 2);
    await b.fake.waitFor(() => b.fake.chat(OWNER).messages.find((m) => m.message_id === m2.message_id)!.reactions.length === 1);
    assert.deepEqual(b.fake.chat(OWNER).messages.find((m) => m.message_id === m2.message_id)!.reactions[0], [{ type: 'emoji', emoji: '👌' }]);
    const m3 = b.fake.sendText(OWNER, 'how are you');
    await b.fake.waitForBotMessages(OWNER, 3);
    await b.fake.waitForIdle(100);
    assert.equal(b.fake.chat(OWNER).messages.find((m) => m.message_id === m3.message_id)!.reactions.length, 0);
  } finally {
    await b.close();
  }
});

test('durable inbox: a message interrupted by a crash is replayed; a finished turn is re-delivered; duplicates are ignored', async () => {
  const db = new Database(':memory:');
  const inbox = new Inbox(db);
  const store = new SqliteStore(db);
  inbox.record(5001, key, OWNER, { kind: 'message', messageId: 1, text: 'message the crash interrupted', media: [] });
  inbox.record(5002, key, OWNER, { kind: 'message', messageId: 2, text: 'already answered', media: [] });
  store.appendMessages(key, [
    { role: 'user', content: 'already answered', at: new Date().toISOString() },
    { role: 'assistant', content: 'The answer that may not have been delivered.', at: new Date().toISOString() },
  ]);
  inbox.mark([5002], 'turn_done', 'The answer that may not have been delivered.');
  assert.equal(inbox.record(5001, key, OWNER, { kind: 'message', text: 'dup', media: [] }), false, 'same update recorded once');
  const b = await boot([(req) => (lastUserText(req).endsWith('register chat') ? { text: 'hi' } : (assert.match(lastUserText(req), /message the crash interrupted$/), { text: 'Picking up where we left off.' }))], { db, repeatLast: true });
  try {
    b.fake.sendText(OWNER, 'register chat');
    await b.fake.waitFor(() => b.model.calls.length >= 1).catch(() => undefined);
    await b.fake.waitForIdle(150);
    const before = b.fake.botMessages(OWNER).length;
    const n = await b.person.replayInbox(b.bot.telegram as never);
    assert.ok(n >= 2);
    await b.fake.waitFor(() => b.fake.botTexts(OWNER).includes('The answer that may not have been delivered.') && b.fake.botTexts(OWNER).includes('Picking up where we left off.'), { label: 'replayed' });
    assert.ok(b.fake.botMessages(OWNER).length >= before + 2);
    await b.fake.waitFor(() => inbox.unfinished().length === 0, { label: 'inbox drained' });
  } finally {
    await b.close();
  }
});
