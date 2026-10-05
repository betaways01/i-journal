import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../../src/core';
import { createSweeper, retryDelayMs } from '../../src/core/sweeper';
import { ScriptedModel, ScriptEntry } from '../../src/core/testing/scriptedModel';
import { ModelUnavailableError } from '../../src/core/types';
import { at, newStore, TZ } from './helpers';

function setup(steps: ScriptEntry[] = [], clock = at('2026-10-02T12:30:00Z')) {
  const store = newStore();
  const model = new ScriptedModel(steps);
  const core = createCore({ store, model, ports: {}, config: { defaultTimezone: TZ } });
  const sent: Array<{ userKey: string; text: string }> = [];
  let failWith: Error | null = null;
  const t = { now: clock };
  const sweeper = createSweeper({
    core,
    now: () => t.now,
    canDeliver: (u) => u !== 'cli-other',
    enqueue: async (_u, job) => job(),
    deliver: async (userKey, text) => {
      if (failWith) throw failWith;
      sent.push({ userKey, text });
    },
  });
  return { store, model, core, sent, sweeper, t, failNext: (e: Error | null) => (failWith = e) };
}

test('due notify reminder is delivered once, recorded, and completed', async () => {
  const s = setup();
  s.store.addReminder('u', { kind: 'notify', text: 'Drink water', fireAt: at('2026-10-02T12:25:00Z') }, at('2026-10-02T12:00:00Z'));
  s.store.addReminder('u', { kind: 'notify', text: 'Later', fireAt: at('2026-10-02T13:00:00Z') }, at('2026-10-02T12:00:00Z'));
  const r1 = await s.sweeper.tick();
  assert.equal(r1.delivered, 1);
  assert.deepEqual(s.sent, [{ userKey: 'u', text: '⏰ Drink water' }]);
  assert.equal(s.store.listReminders('u').length, 1);
  assert.equal(s.store.recentMessages('u', 5).at(-1)?.content, '⏰ Drink water');
  assert.equal(s.store.recentMessages('u', 5).at(-1)?.origin, 'delivered');
  const r2 = await s.sweeper.tick();
  assert.equal(r2.delivered, 0, 'never delivered twice');
  assert.equal(s.sent.length, 1);
});

test('late delivery says so honestly', async () => {
  const s = setup([], at('2026-10-02T15:00:00Z'));
  s.store.addReminder('u', { kind: 'notify', text: 'Call mum', fireAt: at('2026-10-02T12:00:00Z') }, at('2026-10-02T11:00:00Z'));
  await s.sweeper.tick();
  assert.equal(s.sent[0].text, "⏰ Call mum\n_(this was due Fri 2 Oct 2026, 15:00 — sorry it's late)_");
});

test('failed delivery keeps the reminder, retries with backoff, and keeps the schedule', async () => {
  const s = setup();
  const rem = s.store.addReminder('u', { kind: 'notify', text: 'Pray', fireAt: at('2026-10-02T12:25:00Z'), recurrence: { freq: 'daily', interval: 1 } }, at('2026-10-02T12:00:00Z'));
  s.failNext(new Error('network down'));
  const r = await s.sweeper.tick();
  assert.equal(r.deferred, 1);
  const after = s.store.getReminder('u', rem.id)!;
  assert.equal(after.status, 'pending');
  assert.equal(after.attempts, 1);
  assert.equal(after.fireAt, '2026-10-02T12:25:00.000Z');
  assert.equal(after.retryAt, new Date(at('2026-10-02T12:30:00Z').getTime() + retryDelayMs(0)).toISOString());
  assert.equal((await s.sweeper.tick()).deferred, 0, 'not retried before retryAt');
  s.failNext(null);
  s.t.now = at('2026-10-02T12:31:00Z');
  assert.equal((await s.sweeper.tick()).delivered, 1);
  const next = s.store.getReminder('u', rem.id)!;
  assert.equal(next.fireAt, '2026-10-03T12:25:00.000Z', 'daily wall time preserved despite the retry');
  assert.equal(next.attempts, 0);
  assert.equal(next.retryAt, undefined);
});

test('permanent delivery failure cancels; repeated failures give up', async () => {
  const s = setup();
  const a = s.store.addReminder('u', { kind: 'notify', text: 'x', fireAt: at('2026-10-02T12:00:00Z') }, at('2026-10-02T11:00:00Z'));
  s.failNext(Object.assign(new Error('Forbidden: bot was blocked by the user'), { permanent: true }));
  assert.equal((await s.sweeper.tick()).cancelled, 1);
  assert.equal(s.store.getReminder('u', a.id)?.status, 'cancelled');

  const s2 = setup();
  const b = s2.store.addReminder('u', { kind: 'notify', text: 'y', fireAt: at('2026-10-02T12:00:00Z') }, at('2026-10-02T11:00:00Z'));
  s2.failNext(new Error('flaky'));
  for (let i = 0; i < 8; i++) {
    await s2.sweeper.tick();
    s2.t.now = new Date(s2.t.now.getTime() + 60 * 60_000);
  }
  assert.equal(s2.store.getReminder('u', b.id)?.status, 'done', 'gave up after 8 attempts instead of looping forever');
});

test('task reminder runs a scheduled turn; silent tasks send nothing; model down defers', async () => {
  const s = setup([{ text: '"Be still, and know." — Psalm 46:10' }, { toolCalls: [{ name: 'stay_silent', args: {} }] }, { error: new ModelUnavailableError('down') }]);
  const verse = s.store.addReminder('u', { kind: 'task', text: 'Send a short verse', fireAt: at('2026-10-02T12:00:00Z'), recurrence: { freq: 'daily', interval: 1 } }, at('2026-10-02T11:00:00Z'));
  await s.sweeper.tick();
  assert.deepEqual(s.sent, [{ userKey: 'u', text: '"Be still, and know." — Psalm 46:10' }]);
  assert.match(s.model.calls[0].messages.at(-1)!.content as string, /scheduled task they asked for/);
  assert.equal(s.store.getReminder('u', verse.id)?.fireAt, '2026-10-03T12:00:00.000Z');
  s.t.now = at('2026-10-03T12:00:30Z');
  const r = await s.sweeper.tick();
  assert.equal(r.silent, 1);
  assert.equal(s.sent.length, 1);
  s.t.now = at('2026-10-04T12:00:30Z');
  const r3 = await s.sweeper.tick();
  assert.equal(r3.deferred, 1);
  assert.equal(s.store.getReminder('u', verse.id)?.attempts, 1);
});

test('reminders for users this process cannot reach are left alone', async () => {
  const s = setup();
  s.store.addReminder('cli-other', { kind: 'notify', text: 'x', fireAt: at('2026-10-02T12:00:00Z') }, at('2026-10-02T11:00:00Z'));
  await s.sweeper.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.store.listReminders('cli-other').length, 1);
});

test('a reminder cancelled while queued is not delivered', async () => {
  const s = setup();
  const r = s.store.addReminder('u', { kind: 'notify', text: 'x', fireAt: at('2026-10-02T12:00:00Z') }, at('2026-10-02T11:00:00Z'));
  const sweeper = createSweeper({
    core: s.core,
    now: () => s.t.now,
    canDeliver: () => true,
    enqueue: async (_u, job) => {
      s.store.cancelReminder('u', r.id);
      await job();
    },
    deliver: async (userKey, text) => {
      s.sent.push({ userKey, text });
    },
  });
  await sweeper.tick();
  assert.equal(s.sent.length, 0);
});

test('journal nudge timing', async () => {
  const s = setup([{ text: "It's getting late — want to wrap today's page?" }], at('2026-10-02T17:30:00Z')); // 20:30 local
  const st = s.store.getState('u');
  st.journalOpen = true;
  st.journalDate = '2026-10-02';
  st.journalOpenedAt = '2026-10-02T15:00:00Z';
  st.lastSeenAt = '2026-10-02T17:00:00Z';
  s.store.saveState('u', st);
  await s.sweeper.tick();
  assert.equal(s.model.calls.length, 0, 'before 21:00 local');
  s.t.now = at('2026-10-02T18:30:00Z'); // 21:30 local
  await s.sweeper.tick();
  assert.equal(s.model.calls.length, 0, 'no entries on the page');
  s.store.addEntry('u', '2026-10-02', { text: 'Long day.', media: [], at: at('2026-10-02T15:10:00Z'), localTime: '18:10' });
  const fresh = s.store.getState('u');
  fresh.lastSeenAt = '2026-10-02T18:20:00Z';
  s.store.saveState('u', fresh);
  await s.sweeper.tick();
  assert.equal(s.model.calls.length, 0, 'they were active 10 minutes ago');
  s.t.now = at('2026-10-02T19:00:00Z'); // 22:00 local, quiet for 40 min
  const r = await s.sweeper.tick();
  assert.equal(r.nudged, 1);
  assert.equal(s.sent[0].text, "It's getting late — want to wrap today's page?");
  assert.match(s.model.calls[0].messages.at(-1)!.content as string, /background check by the harness/);
  assert.equal(s.store.getState('u').nudgedOn, '2026-10-02');
  s.t.now = at('2026-10-02T20:00:00Z');
  await s.sweeper.tick();
  assert.equal(s.model.calls.length, 1, 'only one nudge per evening');
});

test('silent nudge sends nothing and is not retried that evening', async () => {
  const s = setup([{ toolCalls: [{ name: 'stay_silent', args: {} }] }], at('2026-10-02T19:00:00Z'));
  const st = s.store.getState('u');
  st.journalOpen = true;
  st.journalDate = '2026-10-02';
  s.store.saveState('u', st);
  s.store.addEntry('u', '2026-10-02', { text: 'x', media: [], at: at('2026-10-02T15:00:00Z'), localTime: '18:00' });
  const r = await s.sweeper.tick();
  assert.equal(r.silent, 1);
  assert.equal(s.sent.length, 0);
  await s.sweeper.tick();
  assert.equal(s.model.calls.length, 1);
});

test('start/stop runs ticks on an interval without keeping the process alive', async () => {
  const s = setup();
  s.store.addReminder('u', { kind: 'notify', text: 'tick', fireAt: at('2026-10-02T12:00:00Z') }, at('2026-10-02T11:00:00Z'));
  s.sweeper.start(10);
  await new Promise((r) => setTimeout(r, 60));
  s.sweeper.stop();
  assert.equal(s.sent.length, 1);
});

test('retryDelayMs grows and caps', () => {
  assert.equal(retryDelayMs(0), 30_000);
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(10), 30 * 60_000);
});
