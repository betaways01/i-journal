import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { ftsQuery, openCoreDb, SqliteStore } from '../../src/core/store';

const now = new Date('2026-10-02T12:00:00Z');
const mk = () => new SqliteStore(new Database(':memory:'));
const entry = (text: string, at = now, localTime = '15:00') => ({ text, media: [], at, localTime });

test('profile defaults, save, isolation, no aliasing', () => {
  const s = mk();
  assert.deepEqual(s.getProfile('a'), { name: '', agentName: '', timezone: '' });
  s.saveProfile('a', { name: 'Sam', agentName: 'Kibo', timezone: 'Asia/Riyadh' });
  assert.deepEqual(s.getProfile('a'), { name: 'Sam', agentName: 'Kibo', timezone: 'Asia/Riyadh' });
  assert.deepEqual(s.getProfile('b'), { name: '', agentName: '', timezone: '' });
  const p = s.getProfile('a');
  p.name = 'changed';
  assert.equal(s.getProfile('a').name, 'Sam');
  s.saveProfile('a', { name: 'Samuel', agentName: '', timezone: 'Asia/Riyadh' });
  assert.equal(s.getProfile('a').name, 'Samuel');
});

test('state defaults, round trip, forward compatibility, no aliasing', () => {
  const s = mk();
  assert.deepEqual(s.getState('a'), { journalOpen: false, undo: [], summary: '', summaryThrough: 0, turnCount: 0 });
  const st = s.getState('a');
  st.undo.push({ kind: 'fact', ref: '1', at: now.toISOString(), label: 'x' });
  assert.deepEqual(s.getState('a').undo, []);
  st.journalOpen = true;
  st.journalDate = '2026-10-02';
  st.pendingOffer = { text: 'long day', date: '2026-10-02', at: now.toISOString() };
  s.saveState('a', st);
  const back = s.getState('a');
  assert.equal(back.journalOpen, true);
  assert.equal(back.journalDate, '2026-10-02');
  assert.equal(back.pendingOffer?.text, 'long day');
  assert.equal(back.undo.length, 1);
  assert.equal(s.getState('b').journalOpen, false);
});

test('state rows with missing or corrupt fields load with defaults', () => {
  const db = new Database(':memory:');
  const s = new SqliteStore(db);
  db.prepare('INSERT INTO core_state (user_key, json, updated_at) VALUES (?, ?, ?)').run('old', JSON.stringify({ journalOpen: 1 }), now.toISOString());
  db.prepare('INSERT INTO core_state (user_key, json, updated_at) VALUES (?, ?, ?)').run('bad', '{not json', now.toISOString());
  db.prepare('INSERT INTO core_state (user_key, json, updated_at) VALUES (?, ?, ?)').run('weird', JSON.stringify({ undo: 'x', summary: 5, turnCount: 'n' }), now.toISOString());
  assert.deepEqual(s.getState('old'), { journalOpen: true, undo: [], summary: '', summaryThrough: 0, turnCount: 0 });
  assert.deepEqual(s.getState('bad'), { journalOpen: false, undo: [], summary: '', summaryThrough: 0, turnCount: 0 });
  assert.deepEqual(s.getState('weird'), { journalOpen: false, undo: [], summary: '', summaryThrough: 0, turnCount: 0 });
});

test('facts: add, dedupe case-insensitively, remove, restore with original id', () => {
  const s = mk();
  const a = s.addFact('u', 'fact', '  Has two kids  ', now);
  assert.equal(a.created, true);
  assert.equal(a.fact.text, 'Has two kids');
  const dup = s.addFact('u', 'fact', 'HAS TWO KIDS', now);
  assert.equal(dup.created, false);
  assert.equal(dup.fact.id, a.fact.id);
  const ins = s.addFact('u', 'instruction', 'When I go quiet, ask about my goals', now);
  assert.equal(ins.fact.kind, 'instruction');
  s.addFact('other', 'fact', 'Has two kids', now);
  assert.equal(s.listFacts('u').length, 2);
  assert.equal(s.listFacts('other').length, 1);
  assert.equal(s.removeFact('other', a.fact.id), null, 'cannot remove another user fact');
  const removed = s.removeFact('u', a.fact.id);
  assert.equal(removed?.text, 'Has two kids');
  assert.equal(s.listFacts('u').length, 1);
  s.restoreFact('u', removed!);
  const restored = s.listFacts('u').find((f) => f.id === a.fact.id);
  assert.equal(restored?.text, 'Has two kids');
  assert.equal(restored?.createdAt, a.fact.createdAt);
  assert.throws(() => s.addFact('u', 'fact', '   ', now));
});

test('skills: upsert, list, get, remove, isolation', () => {
  const s = mk();
  s.saveSkill('u', { name: 'verse', description: 'morning verse', body: 'search then send' }, now);
  s.saveSkill('u', { name: 'verse', description: 'morning verse v2', body: 'new body' }, now);
  s.saveSkill('u', { name: 'alpha', description: 'a', body: 'b' }, now);
  assert.deepEqual(s.listSkills('u').map((k) => k.name), ['alpha', 'verse']);
  assert.equal(s.getSkill('u', 'verse')?.body, 'new body');
  assert.equal(s.getSkill('other', 'verse'), null);
  assert.equal(s.removeSkill('other', 'verse'), false);
  assert.equal(s.removeSkill('u', 'verse'), true);
  assert.equal(s.getSkill('u', 'verse'), null);
});

test('journal: add entries, weekday, order, remove, list days', () => {
  const s = mk();
  assert.equal(s.getDay('u', '2026-10-02'), null);
  const one = s.addEntry('u', '2026-10-02', entry('Site visit ran over.'));
  assert.equal(one.day.weekday, 'Friday');
  assert.equal(one.day.entries.length, 1);
  assert.equal(one.entry.text, 'Site visit ran over.');
  const media = [{ kind: 'photo' as const, fileId: 'f1', localPath: '/tmp/x.jpg' }];
  const two = s.addEntry('u', '2026-10-02', { text: 'Pump controller failed twice.', media, at: now, localTime: '16:10' });
  assert.deepEqual(two.day.entries.map((e) => e.text), ['Site visit ran over.', 'Pump controller failed twice.']);
  assert.deepEqual(two.entry.media, media);
  s.addEntry('u', '2026-09-30', entry('Quiet Wednesday.'));
  s.addEntry('other', '2026-10-01', entry('Not yours.'));
  assert.deepEqual(s.listDays('u').map((d) => d.date), ['2026-10-02', '2026-09-30']);
  assert.deepEqual(s.listDays('u', { from: '2026-10-01' }).map((d) => d.date), ['2026-10-02']);
  assert.deepEqual(s.listDays('u', { to: '2026-10-01' }).map((d) => d.date), ['2026-09-30']);
  assert.equal(s.listDays('u', { limit: 1 }).length, 1);
  assert.equal(s.listDays('u')[0].entries, 2);
  assert.equal(s.removeEntry('other', '2026-10-02', one.entry.id), null);
  assert.equal(s.removeEntry('u', '2026-09-30', one.entry.id), null, 'wrong date');
  const removed = s.removeEntry('u', '2026-10-02', two.entry.id);
  assert.deepEqual(removed?.media, media);
  assert.equal(s.getDay('u', '2026-10-02')?.entries.length, 1);
  s.removeEntry('u', '2026-09-30', s.getDay('u', '2026-09-30')!.entries[0].id);
  assert.deepEqual(s.listDays('u').map((d) => d.date), ['2026-10-02'], 'empty day not listed');
  // returned objects are fresh copies
  const d = s.getDay('u', '2026-10-02')!;
  d.entries.push({ id: 999, at: '', localTime: '', text: 'x', media: [] });
  assert.equal(s.getDay('u', '2026-10-02')!.entries.length, 1);
});

test('journal: reflection, close, reopen, does not touch entries', () => {
  const s = mk();
  assert.equal(s.setReflection('u', '2026-10-02', 'x', now), null, 'no day yet');
  s.addEntry('u', '2026-10-02', entry('Long day.'));
  const closed = s.setReflection('u', '2026-10-02', 'A long, honest day.', now);
  assert.equal(closed?.reflection, 'A long, honest day.');
  assert.equal(closed?.closedAt, now.toISOString());
  assert.equal(s.listDays('u')[0].closed, true);
  s.addEntry('u', '2026-10-02', entry('One more thing.'));
  assert.equal(s.getDay('u', '2026-10-02')?.reflection, 'A long, honest day.', 'addEntry keeps reflection');
  const reopened = s.setReflection('u', '2026-10-02', undefined, undefined);
  assert.equal(reopened?.reflection, undefined);
  assert.equal(reopened?.closedAt, undefined);
  assert.equal(reopened?.entries.length, 2);
});

test('journal: dirty tracking by revision survives concurrent writes during sync', () => {
  const s = mk();
  s.addEntry('u', '2026-10-01', entry('a'));
  s.addEntry('u', '2026-10-02', entry('b'));
  assert.deepEqual(s.dirtyDays('u').map((d) => d.date), ['2026-10-01', '2026-10-02']);
  const day = s.getDay('u', '2026-10-01')!;
  s.markDaySynced('u', '2026-10-01', { at: now, rev: day.rev, remotePageId: 'p1', remoteUrl: 'https://x' });
  assert.deepEqual(s.dirtyDays('u').map((d) => d.date), ['2026-10-02']);
  assert.equal(s.getDay('u', '2026-10-01')?.remotePageId, 'p1');
  // a sync of rev N is in flight while an entry lands (rev N+1): the day must stay dirty
  const snapshot = s.getDay('u', '2026-10-02')!;
  s.addEntry('u', '2026-10-02', entry('c'));
  s.markDaySynced('u', '2026-10-02', { at: now, rev: snapshot.rev });
  assert.deepEqual(s.dirtyDays('u').map((d) => d.date), ['2026-10-02']);
  s.markDaySynced('u', '2026-10-02', { at: now });
  assert.deepEqual(s.dirtyDays('u'), []);
  // a stale mark can never move synced_rev backwards
  s.markDaySynced('u', '2026-10-02', { at: now, rev: 1 });
  assert.deepEqual(s.dirtyDays('u'), []);
  // remote id preserved when a later mark omits it
  s.addEntry('u', '2026-10-01', entry('d'));
  s.markDaySynced('u', '2026-10-01', { at: now });
  assert.equal(s.getDay('u', '2026-10-01')?.remotePageId, 'p1');
  // a day whose only entry was removed is not dirty (nothing to render)
  const only = s.addEntry('u', '2026-09-01', entry('gone'));
  s.removeEntry('u', '2026-09-01', only.entry.id);
  assert.ok(!s.dirtyDays('u').some((d) => d.date === '2026-09-01'));
});

test('journal search: stemming, case, multiword ranking, dates, isolation', () => {
  const s = mk();
  s.addEntry('u', '2026-09-28', entry('The pump controller failed twice in Porto.'));
  s.addEntry('u', '2026-09-29', entry('Snapped at Jordan after the controller failed. Felt bad.'));
  s.addEntry('u', '2026-09-30', entry('Quiet day, read about pricing strategy.'));
  s.addEntry('u', '2026-10-01', entry('Estoy agotada hoy. Mucho trabajo.'));
  s.addEntry('u', '2026-10-01', entry('Café with Zoë, résumé review.'));
  s.addEntry('other', '2026-09-29', entry('Jordan is my colleague too.'));
  assert.equal(s.searchJournal('u', 'pumps')[0]?.date, '2026-09-28');
  assert.equal(s.searchJournal('u', 'JORDAN').length, 1);
  assert.equal(s.searchJournal('u', 'jordan')[0].weekday, 'Tuesday');
  const multi = s.searchJournal('u', 'controller failed jordan');
  assert.equal(multi[0].date, '2026-09-29', 'entry with more of the words ranks first');
  assert.ok(multi[0].score > multi[1].score);
  assert.equal(s.searchJournal('u', 'agotada')[0]?.date, '2026-10-01');
  assert.equal(s.searchJournal('u', 'cafe resume').length, 1, 'diacritics folded');
  assert.equal(s.searchJournal('u', 'zoe')[0]?.date, '2026-10-01');
  assert.equal(s.searchJournal('u', 'controller', { from: '2026-09-29' }).length, 1);
  assert.equal(s.searchJournal('u', 'controller', { to: '2026-09-28' }).length, 1);
  assert.equal(s.searchJournal('u', 'controller', { from: '2026-09-28', to: '2026-09-28' })[0].date, '2026-09-28');
  assert.ok(s.searchJournal('u', 'snapped')[0].snippet.includes('Jordan'));
  assert.equal(s.searchJournal('u', 'controller', { limit: 1 }).length, 1);
  assert.deepEqual(s.searchJournal('u', 'zzzznothing'), []);
});

test('journal search never throws on hostile queries', () => {
  const s = mk();
  s.addEntry('u', '2026-10-02', entry('Ordinary words about a NEAR miss and an OR gate.'));
  for (const q of ['"unbalanced OR (NEAR* -x:', '', '   ', '🙂🙂', 'AND', 'OR OR OR', '*', 'NEAR(', 'col:val', "'; DROP TABLE core_journal_entries; --", '^^^', '"""', '-', 'a', '\u0000', 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => s.searchJournal('u', q), q.slice(0, 20));
    assert.doesNotThrow(() => s.searchNotes('u', q), q.slice(0, 20));
  }
  assert.equal(s.searchJournal('u', 'near')[0]?.date, '2026-10-02');
  assert.equal(s.searchJournal('u', 'OR')[0]?.date, '2026-10-02', 'operators are treated as words');
  assert.deepEqual(s.searchJournal('u', ''), []);
  assert.ok(s.getDay('u', '2026-10-02'), 'table survived injection attempt');
});

test('ftsQuery sanitises', () => {
  assert.equal(ftsQuery(''), null);
  assert.equal(ftsQuery('🙂 ✨'), null);
  assert.equal(ftsQuery('Pump OR (fail*'), '"pump"* OR "or" OR "fail"*');
  assert.equal(ftsQuery('a an'), '"a" OR "an"');
  assert.equal(ftsQuery('dup dup'), '"dup"*');
});

test('journal search over a 5k-entry corpus is fast', () => {
  const s = mk();
  const words = ['pump', 'porto', 'jordan', 'pricing', 'family', 'church', 'money', 'boat', 'site', 'client', 'rain', 'kids'];
  for (let i = 0; i < 5000; i++) {
    const date = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
    s.addEntry('u', date, entry(`${words[i % words.length]} ${words[(i * 7) % words.length]} entry number ${i}`));
  }
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) s.searchJournal('u', 'jordan pricing');
  const ms = (Date.now() - t0) / 20;
  assert.ok(ms < 50, `search took ${ms}ms`);
  assert.equal(s.searchJournal('u', 'jordan pricing', { limit: 8 }).length, 8);
});

test('notes: upsert by path case-insensitively, search, list, remove, setNoteBody, dirty', () => {
  const s = mk();
  const a = s.saveNote('u', { notebook: 'Study Group', section: 'Leadership', title: 'Week 6', body: 'Trust is the foundation of leadership.' }, now);
  assert.equal(a.created, true);
  const b = s.saveNote('u', { notebook: 'study group', section: 'LEADERSHIP', title: 'week 6', body: 'Character makes trust possible.' }, now);
  assert.equal(b.created, false);
  assert.equal(b.note.id, a.note.id);
  assert.equal(b.note.body, 'Character makes trust possible.');
  assert.equal(b.note.notebook, 'Study Group', 'keeps original casing');
  s.saveNote('u', { notebook: 'Personal', section: 'MONEY', title: 'Business', body: 'Never mix business money with personal money.' }, now);
  s.saveNote('u', { notebook: 'Personal', section: '', title: 'Loose', body: 'A note with no section.' }, now);
  s.saveNote('other', { notebook: 'Personal', section: 'MONEY', title: 'Business', body: 'other user money' }, now);
  const hits = s.searchNotes('u', 'money');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'Personal / MONEY / Business');
  assert.match(hits[0].ref, /^local:\d+$/);
  assert.equal(s.searchNotes('u', 'leadership')[0].path, 'Study Group / Leadership / Week 6', 'section name is searchable');
  assert.equal(s.searchNotes('u', 'loose')[0].path, 'Personal / Loose', 'empty section omitted from path');
  assert.deepEqual(s.listNotebooks('u'), [
    { notebook: 'Personal', section: '', notes: 1 },
    { notebook: 'Personal', section: 'MONEY', notes: 1 },
    { notebook: 'Study Group', section: 'Leadership', notes: 1 },
  ]);
  assert.equal(s.getNote('other', a.note.id), null);
  assert.equal(s.dirtyNotes('u').length, 3);
  s.markNoteSynced('u', a.note.id, { at: now, remotePageId: 'r1' });
  assert.equal(s.dirtyNotes('u').length, 2);
  assert.equal(s.setNoteBody('u', a.note.id, 'Trust is the foundation of leadership.', now)?.body, 'Trust is the foundation of leadership.');
  assert.equal(s.dirtyNotes('u').length, 3, 'restored body is dirty again');
  assert.equal(s.setNoteBody('other', a.note.id, 'x', now), null);
  assert.equal(s.searchNotes('u', 'character').length, 0, 'fts updated on body change');
  assert.equal(s.searchNotes('u', 'foundation').length, 1);
  assert.equal(s.removeNote('other', a.note.id), null);
  assert.equal(s.removeNote('u', a.note.id)?.title, 'Week 6');
  assert.equal(s.searchNotes('u', 'foundation').length, 0);
  assert.throws(() => s.saveNote('u', { notebook: '', section: '', title: 'x', body: 'y' }, now));
});

test('messages: ordered ids, recent window, after, count, clear, isolation', () => {
  const s = mk();
  const at = now.toISOString();
  const stored = s.appendMessages('u', [
    { role: 'user', content: 'hey', at, origin: 'message', media: [{ kind: 'photo', localPath: '/tmp/a.jpg' }] },
    { role: 'assistant', content: '', at, toolCalls: [{ id: 'c1', name: 'journal_open', arguments: '{}' }] },
    { role: 'tool', content: 'Journal open.', at, toolCallId: 'c1', toolName: 'journal_open' },
    { role: 'assistant', content: 'Open. Go ahead.', at },
  ]);
  assert.equal(stored.length, 4);
  assert.ok(stored.every((m, i) => i === 0 || m.id > stored[i - 1].id));
  assert.deepEqual(stored[1].toolCalls, [{ id: 'c1', name: 'journal_open', arguments: '{}' }]);
  assert.equal(stored[2].toolCallId, 'c1');
  assert.equal(stored[2].toolName, 'journal_open');
  assert.equal(stored[0].media?.[0].kind, 'photo');
  assert.equal(stored[0].origin, 'message');
  assert.equal(stored[3].toolCalls, undefined);
  s.appendMessages('other', [{ role: 'user', content: 'not yours', at }]);
  assert.deepEqual(s.recentMessages('u', 2).map((m) => m.content), ['Journal open.', 'Open. Go ahead.']);
  assert.deepEqual(s.messagesAfter('u', stored[1].id).map((m) => m.id), [stored[2].id, stored[3].id]);
  assert.equal(s.messagesAfter('u', stored[0].id, 1).length, 1);
  assert.equal(s.countMessages('u'), 4);
  assert.deepEqual(s.appendMessages('u', []), []);
  s.clearConversation('u');
  assert.equal(s.countMessages('u'), 0);
  assert.equal(s.countMessages('other'), 1);
});

test('reminders: lifecycle, due across users, recurring advance, defer, scoping', () => {
  const s = mk();
  const t = (iso: string) => new Date(iso);
  const one = s.addReminder('a', { kind: 'notify', text: 'drink water', fireAt: t('2026-10-02T12:02:00Z') }, now);
  const daily = s.addReminder('b', { kind: 'task', text: 'send a verse', fireAt: t('2026-10-02T03:00:00Z'), recurrence: { freq: 'daily', interval: 1 } }, now);
  const later = s.addReminder('a', { kind: 'notify', text: 'call mum', fireAt: t('2026-10-03T09:00:00Z') }, now);
  assert.equal(one.status, 'pending');
  assert.equal(one.attempts, 0);
  assert.deepEqual(daily.recurrence, { freq: 'daily', interval: 1 });
  assert.equal(daily.kind, 'task');
  const due = s.dueReminders(t('2026-10-02T12:05:00Z'));
  assert.deepEqual(due.map((r) => r.id), [daily.id, one.id], 'oldest first across users');
  assert.equal(s.dueReminders(t('2026-10-02T12:05:00Z'), 1).length, 1);
  assert.deepEqual(s.listReminders('a').map((r) => r.text), ['drink water', 'call mum']);
  // failed delivery
  s.deferOccurrence(one.id, t('2026-10-02T12:06:00Z'));
  const deferred = s.getReminder('a', one.id)!;
  assert.equal(deferred.attempts, 1);
  assert.equal(deferred.fireAt, '2026-10-02T12:02:00.000Z', 'the schedule is untouched');
  assert.equal(deferred.retryAt, '2026-10-02T12:06:00.000Z');
  assert.ok(s.dueReminders(t('2026-10-02T12:06:00Z')).some((r) => r.id === one.id), 'due again at retry time');
  assert.ok(!s.dueReminders(t('2026-10-02T12:05:30Z')).some((r) => r.id === one.id));
  // delivered
  s.completeOccurrence(one.id, t('2026-10-02T12:06:01Z'), null);
  const done = s.getReminder('a', one.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.attempts, 0);
  assert.equal(done.lastFiredAt, '2026-10-02T12:06:01.000Z');
  assert.equal(done.retryAt, undefined, 'retry cleared on completion');
  assert.deepEqual(s.listReminders('a').map((r) => r.text), ['call mum']);
  assert.deepEqual(s.listReminders('a', { includeFinished: true }).map((r) => r.text), ['call mum', 'drink water']);
  // recurring advances and stays pending
  s.completeOccurrence(daily.id, t('2026-10-02T03:00:05Z'), t('2026-10-03T03:00:00Z'));
  const adv = s.getReminder('b', daily.id)!;
  assert.equal(adv.status, 'pending');
  assert.equal(adv.fireAt, '2026-10-03T03:00:00.000Z');
  // scoping
  assert.equal(s.getReminder('b', later.id), null);
  assert.equal(s.cancelReminder('b', later.id), null, 'user b cannot cancel user a reminder');
  assert.equal(s.getReminder('a', later.id)?.status, 'pending');
  assert.equal(s.cancelReminder('a', later.id)?.status, 'cancelled');
  assert.equal(s.cancelReminder('a', later.id), null, 'already cancelled');
  assert.equal(s.cancelReminder('a', one.id), null, 'done cannot be cancelled');
  assert.equal(s.restoreReminder('b', later.id), null);
  assert.equal(s.restoreReminder('a', later.id)?.status, 'pending');
  assert.equal(s.restoreReminder('a', one.id), null, 'done cannot be restored');
});

test('listUserKeys spans tables', () => {
  const s = mk();
  s.saveProfile('p', { name: 'x', agentName: '', timezone: '' });
  s.saveState('s', s.getState('s'));
  s.appendMessages('m', [{ role: 'user', content: 'hi', at: now.toISOString() }]);
  s.addEntry('j', '2026-10-02', entry('x'));
  s.addReminder('r', { kind: 'notify', text: 'x', fireAt: now }, now);
  assert.deepEqual(s.listUserKeys(), ['j', 'm', 'p', 'r', 's']);
});

test('file database: migrations idempotent, data survives reopen, coexists with legacy tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-store-'));
  const file = path.join(dir, 'nested', 'db.sqlite');
  try {
    const db1 = openCoreDb(file);
    db1.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_id TEXT)');
    db1.prepare('INSERT INTO users (telegram_id) VALUES (?)').run('123');
    const s1 = new SqliteStore(db1);
    s1.addEntry('u', '2026-10-02', entry('persisted'));
    s1.addFact('u', 'fact', 'likes tea', now);
    db1.close();
    const db2 = openCoreDb(file);
    const s2 = new SqliteStore(db2);
    const s3 = new SqliteStore(db2);
    assert.equal(s2.getDay('u', '2026-10-02')?.entries[0].text, 'persisted');
    assert.equal(s3.searchJournal('u', 'persisted').length, 1);
    assert.equal(s2.listFacts('u')[0].text, 'likes tea');
    assert.equal((db2.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
    assert.equal((db2.prepare('SELECT COUNT(*) AS n FROM core_schema_version').get() as { n: number }).n, 3);
    assert.equal(db2.pragma('journal_mode', { simple: true }), 'wal');
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
