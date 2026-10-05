import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEffects, pathCandidates, unbackedClaim, uncitedPaths } from '../../src/core/loop';
import { repairHistory, storedUserText } from '../../src/core/context';
import { memoryCard, SYSTEM_PROMPT } from '../../src/core/prompt';
import { ChatMessage, Effect } from '../../src/core/types';

const saved: Effect[] = [{ type: 'journal_saved', date: '2026-10-02', entryId: 1, media: 0 }];

test('unbackedClaim flags claims with no matching effect', () => {
  const cases: Array<[string, string]> = [
    ["I've saved that to your journal.", 'saved something to the journal'],
    ["Added it to today's page.", 'saved something to the journal'],
    ["I'll remind you at 15:30 to call mum.", 'set a reminder'],
    ['Your reminder is set for tomorrow.', 'set a reminder'],
    ['I set a reminder for 7am.', 'set a reminder'],
    ["I'll remember that you prefer tea.", 'remembered something'],
    ["Got it, I'll keep that in mind.", 'remembered something'],
    ['Saved it under your Personal notebook.', 'saved a note to their notes'],
    ['Cancelled the reminder.', 'cancelled a reminder'],
    ["It's saved and synced to OneNote.", 'put something in OneNote'],
  ];
  for (const [reply, what] of cases) assert.equal(unbackedClaim(reply, []), what, reply);
  assert.equal(unbackedClaim('Your page is now in OneNote.', saved), 'put something in OneNote', 'not confirmed by anything this turn');
  assert.equal(unbackedClaim('Your page is now in OneNote.', saved, { journalOpen: false, oneNoteConfirmed: true }), null, 'confirmed by the context or a tool');
  assert.equal(unbackedClaim('It will be copied to OneNote in a few minutes.', saved), null, 'future tense is a promise, not a claim');
});

test('unbackedClaim accepts backed claims, offers, questions, negations, and normal talk', () => {
  assert.equal(unbackedClaim("I've added that to your journal.", saved), null);
  assert.equal(unbackedClaim("I'll remind you at 9.", [{ type: 'reminder_set', reminderId: 1 }]), null);
  assert.equal(unbackedClaim("I'll remember that.", [{ type: 'fact_saved', factId: 1 }]), null);
  for (const reply of [
    "Want me to put that on today's page?",
    "Should I save this to your journal?",
    "I haven't saved anything to the journal.",
    "I didn't set a reminder — tell me when.",
    "I can't remind you without a time.",
    'That sounds exhausting. How are you holding up after the site visit?',
    'Here is a lullaby:\nHush now, the stars are out,\nthe day is done.',
    'def sum_odds(xs):\n    return sum(x for x in xs if x % 2)',
    'Canberra is the capital of Australia, with about 470,000 people.',
    'OneNote is not connected, so it stays here.',
  ]) {
    assert.equal(unbackedClaim(reply, []), null, reply);
  }
});

test('pathCandidates and uncitedPaths', () => {
  assert.deepEqual(pathCandidates('From Study Group / Leadership / Week 6: trust first.'), [['From Study Group', 'Leadership', 'Week 6']]);
  assert.deepEqual(pathCandidates('Every Mon / Wed / Fri at 7.'), [], 'all segments short');
  assert.deepEqual(pathCandidates('ratio 1 / 2 / 3'), []);
  assert.deepEqual(pathCandidates('a / b / c / d'), [], 'four segments is not a path');
  const cited = new Set(['Personal / MONEY / Business', 'Study Group / Leadership / 6. Trust First']);
  const books = ['Personal'];
  assert.deepEqual(uncitedPaths('Your note Personal / MONEY / Business says to pay yourself.', cited, books), []);
  assert.deepEqual(uncitedPaths('See Personal / Business for that.', cited, books), [], 'notebook / title of a cited path');
  assert.deepEqual(uncitedPaths('From Personal / Faith / Trust: be consistent.', cited, books), ['From Personal / Faith / Trust']);
  assert.deepEqual(uncitedPaths('Work / life balance matters.', cited, books), [], 'two segments with an unknown first segment are ignored');
  assert.deepEqual(uncitedPaths('Personal / Diet', cited, books), ['Personal / Diet']);
  assert.deepEqual(uncitedPaths('No paths here at all.', cited, books), []);
  assert.deepEqual(uncitedPaths('Lectures / Physics / Week 3', new Set(), []), ['Lectures / Physics / Week 3']);
});

test('describeEffects', () => {
  assert.equal(describeEffects([]), '');
  assert.equal(
    describeEffects([
      { type: 'journal_opened', date: '2026-10-02' },
      { type: 'journal_saved', date: '2026-10-02', entryId: 3, media: 1 },
      { type: 'reminder_set', reminderId: 7 },
      { type: 'searched', where: 'web', hits: 2 },
      { type: 'journal_closed', date: '2026-10-02', wrapped: true },
    ]),
    'opened the journal for 2026-10-02; saved an entry to 2026-10-02; set reminder #7; closed the journal for 2026-10-02 with a reflection'
  );
});

test('repairHistory', () => {
  const h: ChatMessage[] = [
    { role: 'tool', content: 'orphan before start', tool_call_id: 'z' },
    { role: 'assistant', content: 'stray assistant before any user' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'x', arguments: '{}' }, { id: 'b', name: 'y', arguments: '{}' }] },
    { role: 'tool', content: 'ra', tool_call_id: 'a' },
    { role: 'tool', content: 'rb', tool_call_id: 'b' },
    { role: 'assistant', content: 'done' },
    { role: 'assistant', content: 'Reminder — drink water' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'partial', tool_calls: [{ id: 'c', name: 'x', arguments: '{}' }] },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'd', name: 'x', arguments: '{}' }] },
    { role: 'tool', content: 'rd', tool_call_id: 'd' },
    { role: 'tool', content: 'stray', tool_call_id: 'q' },
    { role: 'assistant', content: '' },
  ];
  const out = repairHistory(h);
  assert.deepEqual(
    out.map((m) => [m.role, typeof m.content === 'string' ? m.content : '', (m.tool_calls || []).map((c) => c.id).join(','), m.tool_call_id || '']),
    [
      ['user', 'u1', '', ''],
      ['assistant', '', 'a,b', ''],
      ['tool', 'ra', '', 'a'],
      ['tool', 'rb', '', 'b'],
      ['assistant', 'done\n\nReminder — drink water', '', ''],
      ['user', 'u2', '', ''],
      ['assistant', 'partial', '', ''],
      ['user', 'u3', '', ''],
      ['assistant', '', 'd', ''],
      ['tool', 'rd', '', 'd'],
    ]
  );
  assert.deepEqual(repairHistory([{ role: 'assistant', content: 'x' }]), []);
});

test('storedUserText', () => {
  assert.equal(storedUserText({ kind: 'message', text: 'hi', media: [] }), 'hi');
  assert.equal(storedUserText({ kind: 'message', media: [] }), '(empty message)');
  assert.equal(storedUserText({ kind: 'message', text: 'cute', media: [{ kind: 'photo' }, { kind: 'sticker', emoji: '🐱' }] }), '[photo] [sticker 🐱]\ncute');
  assert.equal(
    storedUserText({ kind: 'message', text: 'this', media: [], target: { text: 'An old message from me that is fairly long', media: [], fromBot: true } }),
    '[replying to your earlier message: "An old message from me that is fairly long"]\nthis'
  );
  assert.equal(storedUserText({ kind: 'message', text: 'Buy now!', media: [], forwarded: true }), '[forwarded message from someone else]\nBuy now!');
  assert.equal(storedUserText({ kind: 'button', text: 'Look', media: [] }), '[tapped a button]\nLook');
  assert.equal(storedUserText({ kind: 'message', media: [{ kind: 'document', fileName: 'cv.pdf' }] }), '[document: cv.pdf]');
});

test('memoryCard', () => {
  const empty = memoryCard({ profile: { name: '', agentName: '', timezone: '' }, facts: [], skills: [], notebooks: [] });
  assert.match(empty, /Their name: \(not told yet\)/);
  assert.match(empty, /Facts: none yet\./);
  const full = memoryCard({
    profile: { name: 'Sam', agentName: 'Kibo', timezone: 'Asia/Riyadh' },
    facts: [
      { id: 1, kind: 'fact', text: 'Builds boat engines', createdAt: '' },
      { id: 2, kind: 'instruction', text: 'When I go quiet, ask about my goals', createdAt: '' },
    ],
    skills: [{ name: 'weekly-review', description: 'Sunday review', body: '', updatedAt: '' }],
    notebooks: [
      { notebook: 'Personal', section: 'MONEY', notes: 1 },
      { notebook: 'Personal', section: 'Faith', notes: 2 },
      { notebook: 'Loose', section: '', notes: 1 },
    ],
  });
  assert.match(full, /Their name: Sam\nName they gave you: Kibo/);
  assert.match(full, /Facts:\n#1 Builds boat engines/);
  assert.match(full, /Standing instructions \(follow these\):\n#2 When I go quiet/);
  assert.match(full, /- weekly-review: Sunday review/);
  assert.match(full, /Local notebooks: Personal \(MONEY, Faith\); Loose/);
  const many = memoryCard({
    profile: { name: '', agentName: '', timezone: '' },
    facts: Array.from({ length: 80 }, (_, i) => ({ id: i + 1, kind: 'fact' as const, text: 'fact ' + i, createdAt: '' })),
    skills: [],
    notebooks: [],
  });
  assert.match(many, /\(20 older facts not shown\)/);
  assert.match(many, /#80 fact 79/);
  assert.doesNotMatch(many, /#1 fact 0\n/);
});

test('system prompt carries no per-user or per-turn data', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /\b(Sam|Kibo|2026)\b/);
  assert.ok(SYSTEM_PROMPT.length < 9000);
});

test('inventedLinks flags links that came from nowhere', async () => {
  const { inventedLinks } = await import('../../src/core/loop');
  const ctx = 'tool said https://login.microsoftonline.com/x and they sent https://example.com/page';
  assert.deepEqual(inventedLinks('Open https://login.microsoftonline.com/x.', ctx), []);
  assert.deepEqual(inventedLinks('See [this](https://example.com/page)', ctx), []);
  assert.deepEqual(inventedLinks('Here: https://connect.example/onenote and https://connect.example/onenote', ctx), ['https://connect.example/onenote']);
  assert.deepEqual(inventedLinks('No links at all.', ctx), []);
});

test('"from here" style promises count as memory claims', async () => {
  const { unbackedClaim } = await import('../../src/core/loop');
  assert.equal(unbackedClaim("Got it — short and casual from here.", []), 'remembered something');
});

test('closing claims and titles with dashes', async () => {
  const { unbackedClaim, uncitedPaths } = await import('../../src/core/loop');
  const open = { journalOpen: true };
  assert.equal(unbackedClaim('Closed it — the page is empty, so nothing to reflect on.', [], open), 'closed the journal');
  assert.equal(unbackedClaim("Page's empty, so nothing to write — closed for today.", [], open), 'closed the journal');
  assert.equal(unbackedClaim('Nothing on the page yet — closing it out. Good night.', [], open), 'closed the journal');
  assert.equal(unbackedClaim('Closed it.', [{ type: 'journal_closed', date: '2026-10-02', wrapped: false }], open), null);
  assert.equal(unbackedClaim('The shop closed early today, so I came home.', []), null, 'not checked when no journal was open');
  const cited = new Set(['Personal / Leadership / Trust First — Trust']);
  assert.deepEqual(uncitedPaths('Saved as **Personal / Leadership / Trust First — Trust**.', cited, ['Personal']), []);
});

test('the model sees real OneNote copy status: in the context and in journal_read', async () => {
  const { harness, fakeLibrary, ctxFor, newStore, NOW } = await import('./helpers');
  const { executeTool } = await import('../../src/core/tools');
  const store = newStore();
  const lib = { ...fakeLibrary(), journalTarget: () => ({ notebook: 'i-Journal', section: 'Daily Entries' }) };
  store.addEntry('u', '2026-10-02', { text: 'Morning run', media: [], at: NOW, localTime: '07:00' });
  const ctx = ctxFor(store, undefined, { ports: { library: lib } });
  const read1 = await executeTool({ id: 'r1', name: 'journal_read', arguments: '{"date":"2026-10-02"}' }, ctx);
  assert.match(read1.content, /OneNote copy: not copied yet/);
  store.markDaySynced('u', '2026-10-02', { at: new Date('2026-10-02T12:00:00Z'), remoteUrl: 'https://onenote.example/p1' });
  const read2 = await executeTool({ id: 'r2', name: 'journal_read', arguments: '{"date":"2026-10-02"}' }, ctx);
  assert.match(read2.content, /OneNote copy: up to date \(copied Fri 2 Oct 2026, 15:00, https:\/\/onenote\.example\/p1\)\./);

  const h = harness([{ text: "It's in OneNote — copied at 15:00." }], { ports: { library: lib } });
  h.store.addEntry('u', '2026-10-02', { text: 'Morning run', media: [], at: NOW, localTime: '07:00' });
  h.store.markDaySynced('u', '2026-10-02', { at: new Date('2026-10-02T12:00:00Z') });
  const r = await h.turn('is today in onenote?');
  assert.deepEqual(r.corrections, [], 'a true statement backed by the context is not corrected');
  const sent = h.model.calls[0].messages.at(-1)!.content as string;
  assert.match(sent, /OneNote: connected\. Journal pages go to i-Journal \/ Daily Entries\. Today's page — OneNote copy: up to date/);
});
