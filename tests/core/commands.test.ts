import test from 'node:test';
import assert from 'node:assert/strict';
import { resetConversation, runDirectTool } from '../../src/core/commands';
import { ScriptedModel } from '../../src/core/testing/scriptedModel';
import { NOW, newStore } from './helpers';

test('runDirectTool opens and closes the journal and leaves a transcript note', async () => {
  const store = newStore();
  const deps = { store, model: new ScriptedModel([]), ports: {} };
  const open = await runDirectTool(deps, 'u', 'journal_open', {}, { now: NOW, command: '/journal' });
  assert.ok(open.ok);
  assert.equal(store.getState('u').journalOpen, true);
  assert.deepEqual(open.effects.map((e) => e.type), ['journal_opened']);
  const msgs = store.recentMessages('u', 5);
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [
    ['user', '/journal'],
    ['assistant', '(/journal → Journal open for Friday 2026-10-02.)'],
  ]);
  store.addEntry('u', '2026-10-02', { text: 'x', media: [], at: NOW, localTime: '15:00' });
  const close = await runDirectTool(deps, 'u', 'journal_close', {}, { now: NOW, command: '/thats_it' });
  assert.match(close.content, /^Journal closed for Friday 2026-10-02\./);
  assert.equal(store.getState('u').journalOpen, false);
});

test('resetConversation clears chat and summary but keeps memory, journal and reminders', () => {
  const store = newStore();
  const deps = { store, model: new ScriptedModel([]), ports: {} };
  store.appendMessages('u', [{ role: 'user', content: 'hi', at: NOW.toISOString() }]);
  store.addFact('u', 'fact', 'likes tea', NOW);
  store.addEntry('u', '2026-10-02', { text: 'x', media: [], at: NOW, localTime: '15:00' });
  store.addReminder('u', { kind: 'notify', text: 'r', fireAt: new Date(NOW.getTime() + 60_000) }, NOW);
  const st = store.getState('u');
  st.summary = 'old summary';
  st.summaryThrough = 5;
  st.pendingOffer = { text: 'x', date: '2026-10-02', at: NOW.toISOString() };
  store.saveState('u', st);
  resetConversation(deps, 'u');
  assert.equal(store.countMessages('u'), 0);
  assert.equal(store.getState('u').summary, '');
  assert.equal(store.getState('u').summaryThrough, 0);
  assert.equal(store.getState('u').pendingOffer, undefined);
  assert.equal(store.listFacts('u').length, 1);
  assert.equal(store.listDays('u').length, 1);
  assert.equal(store.listReminders('u').length, 1);
});
