import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, toolSpecsFor, ALL_TOOLS } from '../../src/core/tools';
import { ToolContext } from '../../src/core/types';
import { at, ctxFor, fakeLibrary, fakeWeb, msg, newStore, NOW } from './helpers';

let seq = 0;
const call = (name: string, args: unknown = {}) => ({ id: 'c' + seq++, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const run = (ctx: ToolContext, name: string, args: unknown = {}) => executeTool(call(name, args), ctx);

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

test('journal_open: today, already open, past-midnight default, explicit, future, pending offer', async () => {
  const store = newStore();
  const ctx = ctxFor(store);
  const r = await run(ctx, 'journal_open');
  assert.ok(r.ok);
  assert.match(r.content, /Journal open for Friday 2026-10-02/);
  assert.equal(ctx.state.journalOpen, true);
  assert.equal(ctx.state.journalDate, '2026-10-02');
  assert.deepEqual(ctx.effects, [{ type: 'journal_opened', date: '2026-10-02' }]);
  assert.match((await run(ctx, 'journal_open')).content, /already open/);

  const late = ctxFor(newStore(), msg('x'), { now: at('2026-10-02T22:30:00Z') }); // 01:30 Sat local
  const lr = await run(late, 'journal_open');
  assert.equal(late.state.journalDate, '2026-10-02');
  assert.match(lr.content, /past midnight/);

  const explicit = ctxFor(newStore());
  await run(explicit, 'journal_open', { date: '2026-09-28' });
  assert.equal(explicit.state.journalDate, '2026-09-28');
  assert.equal((await run(ctxFor(newStore()), 'journal_open', { date: '2026-10-05' })).ok, false);
  assert.equal((await run(ctxFor(newStore()), 'journal_open', { date: 'last week' })).ok, false);

  const offered = ctxFor(newStore());
  offered.state.pendingOffer = { text: 'Long day at the site.', date: '2026-10-02', at: NOW.toISOString() };
  assert.match((await run(offered, 'journal_open')).content, /offered to put this on the page: "Long day at the site."/);
});

test('journal_write gating matrix', async () => {
  // open session
  {
    const store = newStore();
    const ctx = ctxFor(store);
    ctx.state.journalOpen = true;
    ctx.state.journalDate = '2026-10-02';
    ctx.state.journalOpenedAt = NOW.toISOString();
    const r = await run(ctx, 'journal_write', { text: 'Site visit ran over.' });
    assert.ok(r.ok, r.content);
    assert.match(r.content, /Saved to today's page \(Friday 2026-10-02\)\. That page now has 1 entry\. OneNote is not connected/);
    assert.equal(store.getDay('u', '2026-10-02')?.entries[0].text, 'Site visit ran over.');
    assert.equal(store.getDay('u', '2026-10-02')?.entries[0].localTime, '15:02');
    assert.equal(ctx.effects[0].type, 'journal_saved');
    assert.equal(ctx.state.undo[0].kind, 'journal_entry');
  }
  // closed, no ask -> refused and offer stored
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('Long day. The pump failed twice.'));
    const r = await run(ctx, 'journal_write', { text: 'Long day. The pump failed twice.' });
    assert.equal(r.ok, false);
    assert.match(r.content, /Not saved yet: the journal session is closed/);
    assert.match(r.content, /ask once/);
    assert.equal(store.getDay('u', '2026-10-02'), null);
    assert.equal(ctx.state.pendingOffer?.text, 'Long day. The pump failed twice.');
    assert.equal(ctx.effects.length, 0);
  }
  // closed, grounded quote -> saved
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('Snapped at Jordan today. Journal this please.'));
    const r = await run(ctx, 'journal_write', { text: 'Snapped at Jordan today.', user_asked: 'journal this' });
    assert.ok(r.ok, r.content);
    assert.equal(store.getDay('u', '2026-10-02')?.entries.length, 1);
    assert.equal(ctx.state.journalOpen, false, 'a one-off keep does not open the session');
  }
  // closed, quote in the replied-to message
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('this', { target: { text: 'save this one: the kids laughed all dinner', media: [] } }));
    assert.ok((await run(ctx, 'journal_write', { text: 'The kids laughed all dinner.', user_asked: 'save this one' })).ok);
  }
  // closed, invented quote -> refused
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('Long day. The pump failed twice.'));
    const r = await run(ctx, 'journal_write', { text: 'Long day.', user_asked: 'please journal this' });
    assert.equal(r.ok, false);
    assert.match(r.content, /"please journal this" is not in their message this turn/);
  }
  // pending offer accepted -> saved, offer cleared
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('yes'));
    ctx.state.pendingOffer = { text: 'Long day.', date: '2026-10-02', at: NOW.toISOString() };
    assert.ok((await run(ctx, 'journal_write', { text: 'Long day.' })).ok);
    assert.equal(ctx.state.pendingOffer, undefined);
  }
  // scheduled turn -> refused by the runner
  {
    const store = newStore();
    const ctx = ctxFor(store, { kind: 'scheduled', text: 'send a verse', media: [] });
    ctx.state.journalOpen = true;
    const r = await run(ctx, 'journal_write', { text: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.content, /background turn/);
    assert.equal(store.getDay('u', '2026-10-02'), null);
  }
  // duplicate, empty, future, bad date
  {
    const store = newStore();
    const ctx = ctxFor(store);
    ctx.state.journalOpen = true;
    ctx.state.journalOpenedAt = NOW.toISOString();
    ctx.state.journalDate = '2026-10-02';
    assert.ok((await run(ctx, 'journal_write', { text: 'Same line.' })).ok);
    const dup = await run(ctx, 'journal_write', { text: '  same LINE. ' });
    assert.equal(dup.ok, false);
    assert.match(dup.content, /already the last one/);
    assert.equal((await run(ctx, 'journal_write', { text: '   ' })).ok, false);
    assert.match((await run(ctx, 'journal_write', { text: 'x', date: '2026-10-03' })).content, /future/);
    assert.match((await run(ctx, 'journal_write', { text: 'x', date: 'last friday' })).content, /date must be/);
    assert.ok((await run(ctx, 'journal_write', { text: 'Catch-up for Tuesday.', date: '2026-09-29' })).ok);
    assert.equal(store.getDay('u', '2026-09-29')?.entries[0].text, 'Catch-up for Tuesday.');
    assert.ok((await run(ctx, 'journal_write', { text: 'yesterday bit', date: 'yesterday' })).ok);
    assert.equal(store.getDay('u', '2026-10-01')?.entries.length, 1);
  }
});

test('journal_write attaches media from this message, the reply target, or recent history', async () => {
  const photo = { kind: 'photo' as const, fileId: 'f1', localPath: '/tmp/a.jpg' };
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('keep it', { media: [photo] }));
    ctx.state.journalOpen = true;
    const r = await run(ctx, 'journal_write', { text: 'Sunset at the site.', attach_media: true });
    assert.match(r.content, /with 1 attachment/);
    assert.deepEqual(store.getDay('u', '2026-10-02')?.entries[0].media, [photo]);
  }
  {
    const store = newStore();
    store.appendMessages('u', [
      { role: 'user', content: '[photo]', at: NOW.toISOString(), media: [photo] },
      { role: 'assistant', content: 'A sunset over the harbour.', at: NOW.toISOString() },
    ]);
    const ctx = ctxFor(store, msg('keep it'));
    const r = await run(ctx, 'journal_write', { text: '', attach_media: true, user_asked: 'keep it' });
    assert.ok(r.ok, r.content);
    assert.deepEqual(store.getDay('u', '2026-10-02')?.entries[0].media, [photo]);
  }
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('keep', { media: [{ kind: 'sticker', emoji: '🙂' }] }));
    ctx.state.journalOpen = true;
    const r = await run(ctx, 'journal_write', { text: '', attach_media: true });
    assert.equal(r.ok, false, 'stickers are not attachments');
  }
});

test('journal_write late-night continuity and stale sessions', async () => {
  // opened 23:00 Friday, writing 01:30 Saturday -> Friday
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('x'), { now: at('2026-10-02T22:30:00Z') });
    ctx.state.journalOpen = true;
    ctx.state.journalDate = '2026-10-02';
    ctx.state.journalOpenedAt = '2026-10-02T20:00:00Z';
    const r = await run(ctx, 'journal_write', { text: "Can't sleep." });
    assert.match(r.content, /Friday 2026-10-02's page/);
    assert.equal(store.getDay('u', '2026-10-02')?.entries.length, 1);
  }
  // same session at 09:00 Saturday -> rolls onto Saturday and the session follows
  {
    const store = newStore();
    const ctx = ctxFor(store, msg('x'), { now: at('2026-10-03T06:00:00Z') });
    ctx.state.journalOpen = true;
    ctx.state.journalDate = '2026-10-02';
    ctx.state.journalOpenedAt = '2026-10-02T20:00:00Z';
    await run(ctx, 'journal_write', { text: 'Morning.' });
    assert.equal(store.getDay('u', '2026-10-03')?.entries.length, 1);
    assert.equal(ctx.state.journalDate, '2026-10-03');
  }
  // catch-up session opened today for a past day keeps writing there
  {
    const store = newStore();
    const ctx = ctxFor(store);
    await run(ctx, 'journal_open', { date: '2026-09-28' });
    await run(ctx, 'journal_write', { text: 'Monday was quiet.' });
    assert.equal(store.getDay('u', '2026-09-28')?.entries.length, 1);
    assert.equal(store.getDay('u', '2026-10-02'), null);
  }
});

test('journal_close: empty page, reflection, closing a non-open day, undo record', async () => {
  {
    const store = newStore();
    const ctx = ctxFor(store);
    ctx.state.journalOpen = true;
    ctx.state.journalDate = '2026-10-02';
    const r = await run(ctx, 'journal_close', { reflection: 'Invented.' });
    assert.match(r.content, /nothing to wrap and no page was created/);
    assert.equal(ctx.state.journalOpen, false);
    assert.equal(store.getDay('u', '2026-10-02'), null);
  }
  {
    const store = newStore();
    const ctx = ctxFor(store);
    ctx.state.journalOpen = true;
    ctx.state.journalDate = '2026-10-02';
    ctx.state.journalOpenedAt = NOW.toISOString();
    await run(ctx, 'journal_write', { text: 'Pump failed twice.' });
    const r = await run(ctx, 'journal_close', { reflection: 'A hard, honest day of work.' });
    assert.ok(r.ok);
    assert.match(r.content, /Journal closed for Friday 2026-10-02 with your reflection/);
    assert.match(r.content, /15:02 — Pump failed twice\./);
    assert.match(r.content, /## Reflection\nA hard, honest day of work\./);
    assert.equal(store.getDay('u', '2026-10-02')?.reflection, 'A hard, honest day of work.');
    assert.equal(ctx.state.journalOpen, false);
    assert.equal(ctx.state.undo[0].kind, 'journal_close');
    assert.deepEqual(ctx.effects.at(-1), { type: 'journal_closed', date: '2026-10-02', wrapped: true });
  }
  {
    const store = newStore();
    store.addEntry('u', '2026-10-02', { text: 'kept earlier', media: [], at: NOW, localTime: '10:00' });
    const ctx = ctxFor(store);
    const r = await run(ctx, 'journal_close', {});
    assert.match(r.content, /^Wrapped for Friday 2026-10-02\./);
    assert.equal(store.getDay('u', '2026-10-02')?.reflection, undefined);
  }
});

test('journal_read and journal_search', async () => {
  const store = newStore();
  store.addEntry('u', '2026-09-29', { text: 'Snapped at Jordan after the controller failed.', media: [], at: NOW, localTime: '18:00' });
  store.addEntry('u', '2026-10-01', { text: 'Kids played well.', media: [{ kind: 'photo' }], at: NOW, localTime: '19:00' });
  store.setReflection('u', '2026-10-01', 'Good evening.', NOW);
  const ctx = ctxFor(store);
  assert.match((await run(ctx, 'journal_read', { date: 'yesterday' })).content, /# Thursday 2026-10-01\n- 19:00 — Kids played well\. \[photo\]\n\n## Reflection\nGood evening\./);
  assert.match((await run(ctx, 'journal_read', {})).content, /Nothing is written on Friday 2026-10-02/);
  const range = (await run(ctx, 'journal_read', { from: '2026-10-02', to: '2026-09-01' })).content;
  assert.ok(range.indexOf('2026-09-29') < range.indexOf('2026-10-01'), 'chronological');
  assert.match((await run(ctx, 'journal_read', { from: '2026-01-01', to: '2026-01-31' })).content, /Nothing was written between/);
  assert.equal((await run(ctx, 'journal_read', { from: 'monday' })).ok, false);
  assert.equal((await run(ctx, 'journal_read', { date: 'someday' })).ok, false);

  const s = await run(ctx, 'journal_search', { query: 'jordan' });
  assert.match(s.content, /^Tue 2026-09-29 18:00 — Snapped at Jordan/);
  assert.deepEqual(ctx.effects.at(-1), { type: 'searched', where: 'journal', hits: 1 });
  assert.match((await run(ctx, 'journal_search', { query: 'unicorns' })).content, /No journal entries match/);
  assert.equal((await run(ctx, 'journal_search', { query: '' })).ok, false);
  assert.equal((await run(ctx, 'journal_search', { query: 'kids', from: 'x' })).ok, false);
  assert.match((await run(ctx, 'journal_search', { query: 'kids jordan', to: '2026-09-30' })).content, /Jordan/);
});

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

test('notes: save new, update with previous body for undo, search cites, read', async () => {
  const store = newStore();
  const ctx = ctxFor(store);
  const r1 = await run(ctx, 'notes_save', { notebook: 'Personal', section: 'MONEY', title: 'Business', body: 'Never mix business money with personal money.' });
  assert.match(r1.content, /Saved new note Personal \/ MONEY \/ Business\. OneNote is not connected/);
  assert.equal(ctx.state.undo[0].prev, undefined);
  const r2 = await run(ctx, 'notes_save', { notebook: 'personal', section: 'money', title: 'business', body: 'Pay yourself a salary.' });
  assert.match(r2.content, /Updated note/);
  assert.deepEqual(JSON.parse(ctx.state.undo[0].prev || '{}'), { body: 'Never mix business money with personal money.' });
  assert.ok(ctx.cited.has('Personal / MONEY / Business'));

  const fresh = ctxFor(store);
  const s = await run(fresh, 'notes_search', { query: 'salary' });
  assert.match(s.content, /^\[local:\d+\] Personal \/ MONEY \/ Business \(2026-10-02\) — Pay yourself a salary\./);
  assert.ok(fresh.cited.has('Personal / MONEY / Business'));
  const ref = /\[(local:\d+)\]/.exec(s.content)![1];
  assert.match((await run(fresh, 'notes_read', { ref })).content, /Pay yourself a salary/);
  assert.equal((await run(fresh, 'notes_read', { ref: 'local:9999' })).ok, false);
  assert.equal((await run(fresh, 'notes_read', { ref: 'remote:x' })).ok, false, 'no library port');
  assert.equal((await run(fresh, 'notes_read', { ref: 'garbage' })).ok, false);
  assert.match((await run(fresh, 'notes_search', { query: 'unicorn' })).content, /^No matching notes for "unicorn"\.$/);
  assert.equal((await run(fresh, 'notes_save', { notebook: '', title: 't', body: 'b' })).ok, false);
  assert.equal((await run(fresh, 'notes_save', { notebook: 'n', title: 't', body: '' })).ok, false);
});

test('notes with a remote library: merge, failure is reported, remote read', async () => {
  const store = newStore();
  store.saveNote('u', { notebook: 'Personal', section: 'Faith', title: 'Trust', body: 'Trust grows with consistency.' }, NOW);
  const ctx = ctxFor(store, msg('x'), { ports: { library: fakeLibrary() } });
  const s = await run(ctx, 'notes_search', { query: 'trust' });
  assert.match(s.content, /Personal \/ Faith \/ Trust/);
  assert.match(s.content, /\[remote:abc\] Study Group \/ Leadership \/ 6\. Trust First/);
  assert.ok(ctx.cited.has('Study Group / Leadership / 6. Trust First'));
  assert.match((await run(ctx, 'notes_read', { ref: 'remote:abc' })).content, /Character makes trust possible/);
  assert.equal((await run(ctx, 'notes_read', { ref: 'remote:zzz' })).ok, false);
  const broken = ctxFor(store, msg('x'), { ports: { library: fakeLibrary({ search: async () => { throw new Error('needs reauth'); } }) } });
  const b = await run(broken, 'notes_search', { query: 'trust' });
  assert.ok(b.ok);
  assert.match(b.content, /Personal \/ Faith \/ Trust/);
  assert.match(b.content, /OneNote search failed: needs reauth\. Only local notes were searched\./);
  const saved = ctxFor(store, msg('x'), { ports: { library: fakeLibrary() } });
  assert.match((await run(saved, 'notes_save', { notebook: 'A', title: 'B', body: 'c' })).content, /copied to OneNote in the background; that copy is not confirmed yet/);
});

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

test('remember, forget, profile_update, skills', async () => {
  const store = newStore();
  const ctx = ctxFor(store);
  const r = await run(ctx, 'remember', { text: 'Builds boat engines in Porto' });
  assert.match(r.content, /^Kept as fact #\d+: Builds boat engines in Porto$/);
  assert.match((await run(ctx, 'remember', { text: 'builds boat engines in porto' })).content, /Already kept/);
  const ins = await run(ctx, 'remember', { text: 'When I go quiet, ask about my goals', kind: 'instruction' });
  assert.match(ins.content, /instruction/);
  assert.equal(store.listFacts('u').length, 2);
  const id = store.listFacts('u')[0].id;
  assert.match((await run(ctx, 'forget', { id })).content, /Forgot/);
  assert.equal((await run(ctx, 'forget', { id })).ok, false);
  assert.equal((await run(ctx, 'forget', { id: 'abc' })).ok, false);
  assert.equal((await run(ctx, 'remember', { text: '' })).ok, false);

  assert.equal((await run(ctx, 'profile_update', { timezone: 'Mars/Base' })).ok, false);
  assert.equal((await run(ctx, 'profile_update', {})).ok, false);
  const p = await run(ctx, 'profile_update', { name: 'Sam', agent_name: 'Kibo', timezone: 'Europe/London' });
  assert.match(p.content, /name: Sam; your name: Kibo; timezone: Europe\/London/);
  assert.deepEqual(store.getProfile('u'), { name: 'Sam', agentName: 'Kibo', timezone: 'Europe/London' });
  assert.equal(ctx.timezone, 'Europe/London');
  assert.match((await run(ctx, 'profile_update', { name: 'Sam' })).content, /Already up to date/);

  assert.equal((await run(ctx, 'skill_save', { name: 'Bad Name', description: 'd', body: 'b' })).ok, false);
  assert.match((await run(ctx, 'skill_save', { name: 'weekly-review', description: 'Sunday review', body: '1. read the week' })).content, /Saved skill/);
  assert.match((await run(ctx, 'skill_save', { name: 'weekly-review', description: 'Sunday review', body: '2' })).content, /Updated skill/);
  assert.match((await run(ctx, 'skill_read', { name: 'weekly-review' })).content, /# weekly-review\nSunday review\n\n2/);
  assert.equal((await run(ctx, 'skill_read', { name: 'nope' })).ok, false);
  for (let i = 0; i < 29; i++) await run(ctx, 'skill_save', { name: 'skill-' + i, description: 'd', body: 'b' });
  assert.match((await run(ctx, 'skill_save', { name: 'one-too-many', description: 'd', body: 'b' })).content, /already have 30 skills/);
});

// ---------------------------------------------------------------------------
// reminders
// ---------------------------------------------------------------------------

test('remind_set validation and resolution in a UTC+3 zone', async () => {
  const store = newStore();
  const ctx = ctxFor(store);
  const r = await run(ctx, 'remind_set', { text: 'Drink water', in_minutes: 20 });
  assert.match(r.content, /Reminder set: #\d+ "Drink water" — Fri 2 Oct 2026, 15:22 \(in 20 minutes\)\. I will send it to them myself/);
  const rem = store.listReminders('u')[0];
  assert.equal(rem.fireAt, '2026-10-02T12:22:00.000Z');
  const a = await run(ctx, 'remind_set', { text: 'Call mum', at: '2026-10-03 07:00' });
  assert.match(a.content, /Sat 3 Oct 2026, 07:00/);
  assert.equal(store.listReminders('u')[1].fireAt, '2026-10-03T04:00:00.000Z');
  const past = await run(ctx, 'remind_set', { text: 'x', at: '2026-10-02 15:00' });
  assert.equal(past.ok, false);
  assert.match(past.content, /has already passed\. It is now Fri 2 Oct 2026, 15:02 \(Asia\/Riyadh\)/);
  assert.match((await run(ctx, 'remind_set', { text: 'x', at: '2026-10-02 16:00', in_minutes: 5 })).content, /not both/);
  assert.match((await run(ctx, 'remind_set', { text: 'x' })).content, /give `at`/);
  assert.match((await run(ctx, 'remind_set', { text: 'x', at: '3pm tomorrow' })).content, /must look like/);
  assert.match((await run(ctx, 'remind_set', { text: 'x', in_minutes: -5 })).content, /positive/);
  assert.match((await run(ctx, 'remind_set', { text: 'x', in_minutes: 'soon' })).content, /positive/);
  assert.match((await run(ctx, 'remind_set', { text: 'x', in_minutes: 99_999_999 })).content, /five years/);
  assert.equal((await run(ctx, 'remind_set', { text: '', in_minutes: 5 })).ok, false);
  assert.match((await run(ctx, 'remind_set', { text: 'x', in_minutes: 5, repeat: { freq: 'yearly' } })).content, /repeat must be/);
  assert.match((await run(ctx, 'remind_set', { text: 'x', in_minutes: 5, repeat: { freq: 'minutely', interval: 1 } })).content, /every 5 minutes/);
  const t = await run(ctx, 'remind_set', { text: 'Send a short verse on patience', at: '2026-10-03 06:00', repeat: { freq: 'daily' }, kind: 'task' });
  assert.match(t.content, /\[task\].*repeats every day\. At that time I will run this as an instruction/);
  assert.equal(store.listReminders('u').length, 3);
});

test('remind_set in a DST zone resolves wall time correctly', async () => {
  const store = newStore();
  const ctx = ctxFor(store, msg('x'), { timezone: 'America/New_York', now: at('2026-03-07T15:00:00Z') });
  await run(ctx, 'remind_set', { text: 'standup', at: '2026-03-09 09:00' });
  assert.equal(store.listReminders('u')[0].fireAt, '2026-03-09T13:00:00.000Z', 'EDT after spring forward');
  await run(ctx, 'remind_set', { text: 'gap', at: '2026-03-08 02:30' });
  assert.equal(store.listReminders('u').find((r) => r.text === 'gap')?.fireAt, '2026-03-08T07:00:00.000Z', 'nonexistent time moves past the gap');
});

test('remind_list and remind_cancel are scoped', async () => {
  const store = newStore();
  const a = ctxFor(store);
  const b = ctxFor(store, msg('x'), { userKey: 'other', state: store.getState('other') });
  assert.equal((await run(a, 'remind_list')).content, 'No pending reminders.');
  await run(a, 'remind_set', { text: 'Pray', in_minutes: 60 });
  const id = store.listReminders('u')[0].id;
  assert.match((await run(a, 'remind_list')).content, new RegExp(`#${id} "Pray" — Fri 2 Oct 2026, 16:02 \\(in 1h 0m\\)`));
  assert.equal((await run(b, 'remind_cancel', { id })).ok, false);
  assert.match((await run(a, 'remind_cancel', { id })).content, /Cancelled reminder/);
  assert.equal((await run(a, 'remind_cancel', { id })).ok, false);
});

// ---------------------------------------------------------------------------
// web, undo, runner invariants
// ---------------------------------------------------------------------------

test('web tools: unavailable, results labelled untrusted, turn becomes tainted, failures honest', async () => {
  const store = newStore();
  const none = ctxFor(store);
  assert.equal((await run(none, 'web_search', { query: 'x' })).ok, false);
  const ctx = ctxFor(store, msg('look it up'), { ports: { web: fakeWeb() } });
  const r = await run(ctx, 'web_search', { query: 'capital of australia' });
  assert.match(r.content, /^Untrusted web content follows/);
  assert.equal(ctx.tainted, true);
  assert.match((await run(ctx, 'web_fetch', { url: 'https://example.com' })).content, /Untrusted web content/);
  assert.equal((await run(ctx, 'web_fetch', { url: 'file:///etc/passwd' })).ok, false);
  const bad = ctxFor(store, msg('x'), { ports: { web: fakeWeb({ search: async () => { throw new Error('all providers down'); } }) } });
  assert.match((await run(bad, 'web_search', { query: 'x' })).content, /Web search failed: all providers down/);
  assert.equal(bad.tainted, false, 'a failed search adds no content');
});

test('undo reverses each kind of change, most recent first', async () => {
  const store = newStore();
  const ctx = ctxFor(store, msg('x'));
  ctx.state.journalOpen = true;
  ctx.state.journalOpenedAt = NOW.toISOString();
  ctx.state.journalDate = '2026-10-02';
  await run(ctx, 'journal_write', { text: 'one' });
  await run(ctx, 'notes_save', { notebook: 'N', title: 'T', body: 'v1' });
  await run(ctx, 'notes_save', { notebook: 'N', title: 'T', body: 'v2' });
  await run(ctx, 'remember', { text: 'likes tea' });
  const factId = store.listFacts('u')[0].id;
  await run(ctx, 'forget', { id: factId });
  await run(ctx, 'remind_set', { text: 'r', in_minutes: 10 });
  const remId = store.listReminders('u')[0].id;
  await run(ctx, 'remind_cancel', { id: remId });
  await run(ctx, 'journal_close', { reflection: 'ok day' });

  assert.match((await run(ctx, 'undo')).content, /Reopened 2026-10-02 — the journal is open again/);
  assert.equal(ctx.state.journalOpen, true);
  assert.equal(store.getDay('u', '2026-10-02')?.reflection, undefined);
  assert.match((await run(ctx, 'undo')).content, /back on/);
  assert.equal(store.getReminder('u', remId)?.status, 'pending');
  assert.match((await run(ctx, 'undo')).content, /Cancelled reminder/);
  assert.equal(store.getReminder('u', remId)?.status, 'cancelled');
  assert.match((await run(ctx, 'undo')).content, /Brought back/);
  assert.equal(store.listFacts('u')[0].id, factId);
  assert.match((await run(ctx, 'undo')).content, /Forgot "likes tea" again/);
  assert.equal(store.listFacts('u').length, 0);
  assert.match((await run(ctx, 'undo')).content, /Restored the previous text/);
  const note = store.searchNotes('u', 'v1')[0];
  assert.ok(note);
  assert.match((await run(ctx, 'undo')).content, /Deleted the note N \/ T/);
  assert.equal(store.searchNotes('u', 'v1').length, 0);
  assert.match((await run(ctx, 'undo')).content, /Removed "one" from 2026-10-02/);
  assert.equal(store.getDay('u', '2026-10-02')?.entries.length, 0);
  assert.equal((await run(ctx, 'undo')).content, 'Nothing to undo.');
});

test('runner: bad JSON, double-encoded JSON, non-object, unknown tool, crash, result cap', async () => {
  const store = newStore();
  const ctx = ctxFor(store);
  const bad = await executeTool(call('remember', '{"text": "tea"'), ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.content, /not valid JSON/);
  const dbl = await executeTool(call('remember', JSON.stringify(JSON.stringify({ text: 'tea' }))), ctx);
  assert.ok(dbl.ok, dbl.content);
  assert.match((await executeTool(call('remember', '[1,2]'), ctx)).content, /must be a JSON object/);
  assert.equal((await executeTool(call('journal_read', ''), ctx)).ok, true, 'empty args are {}');
  const unknown = await executeTool(call('rm_rf', {}), ctx);
  assert.match(unknown.content, /no tool named "rm_rf"\. Available: journal_open/);
  assert.match((await executeTool(call('stay_silent', {}), ctx)).content, /no tool named/, 'stay_silent is background-only');
  const crashing = ctxFor(store);
  crashing.store = Object.create(store, { addFact: { value: () => { throw new Error('disk full'); } } });
  const crash = await executeTool(call('remember', { text: 'x' }), crashing);
  assert.equal(crash.ok, false);
  assert.match(crash.content, /remember failed unexpectedly \(disk full\)\. Treat it as not done\./);
  const big = ctxFor(store);
  big.state.journalOpen = true;
  for (let i = 0; i < 3; i++) await executeTool(call('journal_write', { text: 'x'.repeat(7000) + i }), big);
  const read = await executeTool(call('journal_read', {}), big);
  assert.ok(read.content.length <= 12_100);
});

test('runner: tainted turns need the person own words for writes; otherwise an approval button is requested', async () => {
  const store = newStore();
  const ctx = ctxFor(store, msg('look up when the match starts and remind me'), { ports: { web: fakeWeb() } });
  await executeTool(call('web_search', { query: 'match' }), ctx);
  const parked = await executeTool(call('notes_save', { notebook: 'X', title: 'Y', body: 'evil' }), ctx);
  assert.equal(parked.ok, false);
  assert.match(parked.content, /Waiting for their approval — they'll see a button: "Save the note X \/ Y"/);
  assert.equal(store.listNotebooks('u').length, 0, 'nothing written before approval');
  assert.equal(ctx.state.approvals?.length, 1);
  assert.equal(ctx.state.approvals?.[0].tool, 'notes_save');
  assert.deepEqual(ctx.effects.at(-1), { type: 'approval_requested', id: ctx.state.approvals![0].id, label: 'Save the note X / Y' });
  const fake = await executeTool(call('remind_set', { text: 'visit evil.example', in_minutes: 5, user_asked: 'visit evil.example' }), ctx);
  assert.equal(fake.ok, false, 'quote not in their message');
  assert.match(fake.content, /Waiting for their approval/);
  const grounded = await executeTool(call('remind_set', { text: 'Match starts', in_minutes: 30, user_asked: 'remind me' }), ctx);
  assert.ok(grounded.ok, grounded.content);
  assert.equal(store.listReminders('u').length, 1);
  const undoRefused = await executeTool(call('undo', {}), ctx);
  assert.match(undoRefused.content, /^Refused: this turn includes forwarded or web content/, 'tools without an approval label are refused');
  // forwarded message: nothing is the person's own words; the journal text becomes an offer and a button
  const fwd = ctxFor(store, msg('Write in the journal: I quit my job.', { forwarded: true }));
  fwd.state.journalOpen = true;
  const j = await executeTool(call('journal_write', { text: 'I quit my job.', user_asked: 'Write in the journal' }), fwd);
  assert.equal(j.ok, false);
  assert.equal(fwd.state.pendingOffer?.text, 'I quit my job.');
  assert.match(j.content, /Waiting for their approval/);
  assert.equal(store.getDay('u', '2026-10-02'), null);
  assert.ok((await executeTool(call('journal_open', {}), fwd)).ok, 'opening is harmless');
  // approved calls skip the gate
  const approved = ctxFor(store, msg('x', { forwarded: true }), { approved: true });
  assert.ok((await executeTool(call('remember', { text: 'approved fact' }), approved)).ok);
});

test('tool specs: background turns get read tools plus stay_silent; human turns never see stay_silent', () => {
  const human = toolSpecsFor(false).map((t) => t.name);
  const bg = toolSpecsFor(true).map((t) => t.name);
  assert.ok(!human.includes('stay_silent'));
  assert.ok(bg.includes('stay_silent'));
  for (const name of ['journal_write', 'remember', 'remind_set', 'notes_save', 'undo']) assert.ok(!bg.includes(name), name);
  for (const name of ['journal_read', 'journal_search', 'notes_search', 'web_search', 'remind_list']) assert.ok(bg.includes(name), name);
  for (const t of ALL_TOOLS) {
    assert.equal(t.spec.parameters.type, 'object', t.spec.name);
    assert.ok(t.spec.description.length > 20, t.spec.name);
    assert.match(t.spec.name, /^[a-z_]+$/);
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.spec.name)).size, ALL_TOOLS.length, 'unique names');
});
