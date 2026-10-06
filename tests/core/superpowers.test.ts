import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { AddressInfo } from 'net';
import { SqliteStore } from '../../src/core/store';
import { executeTool } from '../../src/core/tools';
import { resolveApproval } from '../../src/core/commands';
import { tidyMemory } from '../../src/core/maintenance';
import { unbackedClaim } from '../../src/core/loop';
import { createDataPort } from '../../src/core/ports/data';
import { createSense, senseFromKeys } from '../../src/core/ports/sense';
import { createWebPort, newsUrl } from '../../src/core/ports/web';
import { runTurn } from '../../src/core/loop';
import { ScriptedModel, lastUserText, toolResultsIn } from '../../src/core/testing/scriptedModel';
import { DataPort, ModelUnavailableError } from '../../src/core/types';
import { ctxFor, fakeWeb, harness, msg, newStore, NOW } from './helpers';

let seq = 0;
const call = (name: string, args: unknown = {}) => ({ id: 's' + seq++, name, arguments: JSON.stringify(args) });

// ---------------------------------------------------------------------------
// store additions
// ---------------------------------------------------------------------------

test('conversation search finds old messages, skips tool output, isolates users, follows deletes', () => {
  const s = newStore();
  const at = NOW.toISOString();
  s.appendMessages('u', [
    { role: 'user', content: 'We should price the pumps at cost plus thirty percent', at },
    { role: 'assistant', content: 'Cost-plus is simple; value pricing may earn more.', at },
    { role: 'tool', content: 'pricing pricing pricing', at, toolCallId: 'x', toolName: 'web_search' },
  ]);
  s.appendMessages('other', [{ role: 'user', content: 'pricing secrets of another user', at }]);
  const hits = s.searchMessages('u', 'pricing pumps');
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.role !== 'tool'));
  assert.match(hits[0].snippet, /pumps|pricing/i);
  assert.deepEqual(s.searchMessages('u', ''), []);
  assert.deepEqual(s.searchMessages('u', '"(NEAR'), []);
  s.clearConversation('u');
  assert.deepEqual(s.searchMessages('u', 'pricing'), []);
  assert.equal(s.searchMessages('other', 'pricing').length, 1);
});

test('migration 2 backfills conversation search for existing messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig2-'));
  try {
    const file = path.join(dir, 'db.sqlite');
    const db = new Database(file);
    new SqliteStore(db).appendMessages('u', [{ role: 'user', content: 'inverter repaired on Tuesday', at: NOW.toISOString() }]);
    db.exec("DROP TABLE core_messages_fts; DROP TRIGGER core_messages_fts_ai; DROP TRIGGER core_messages_fts_ad; DROP TABLE core_secrets; DROP TABLE core_turns; DROP TABLE core_issues; DELETE FROM core_schema_version WHERE version >= 2;");
    db.close();
    const s = new SqliteStore(new Database(file));
    assert.equal(s.searchMessages('u', 'inverter').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets are encrypted at rest, scoped per user, host-bound, and unreadable with another key', () => {
  const db = new Database(':memory:');
  const s = new SqliteStore(db, { secretKey: 'k1' });
  s.setSecret('u', 'GROQ_API_KEY', 'gsk_live_value_123', ['api.groq.com'], NOW);
  const raw = db.prepare('SELECT value_enc FROM core_secrets').get() as { value_enc: string };
  assert.ok(!raw.value_enc.includes('gsk_live_value_123'), 'not stored in plain text');
  assert.deepEqual(s.getSecret('u', 'GROQ_API_KEY'), { value: 'gsk_live_value_123', hosts: ['api.groq.com'] });
  assert.equal(s.getSecret('other', 'GROQ_API_KEY'), null);
  s.allowSecretHost('u', 'GROQ_API_KEY', 'API.example.com');
  assert.deepEqual(s.getSecret('u', 'GROQ_API_KEY')?.hosts, ['api.groq.com', 'api.example.com']);
  assert.deepEqual(s.listSecrets('u').map((x) => x.name), ['GROQ_API_KEY']);
  const wrongKey = new SqliteStore(db, { secretKey: 'k2' });
  assert.equal(wrongKey.getSecret('u', 'GROQ_API_KEY'), null);
  assert.equal(s.removeSecret('u', 'GROQ_API_KEY'), true);
  assert.equal(s.getSecret('u', 'GROQ_API_KEY'), null);
});

test('wipeUser chat / memory / all', () => {
  const seed = () => {
    const s = newStore();
    s.appendMessages('u', [{ role: 'user', content: 'hi', at: NOW.toISOString() }]);
    s.addFact('u', 'fact', 'likes tea', NOW);
    s.saveSkill('u', { name: 'weekly', description: 'd', body: 'b' }, NOW);
    s.saveProfile('u', { name: 'Sam', agentName: '', timezone: 'Asia/Riyadh' });
    s.addEntry('u', '2026-10-02', { text: 'x', media: [], at: NOW, localTime: '15:00' });
    s.saveNote('u', { notebook: 'N', section: '', title: 'T', body: 'b' }, NOW);
    s.addReminder('u', { kind: 'notify', text: 'r', fireAt: new Date(NOW.getTime() + 60_000) }, NOW);
    s.setSecret('u', 'K', 'v', [], NOW);
    const st = s.getState('u');
    st.summary = 'sum';
    st.journalOpen = true;
    st.usage = { '2026-10-02': { prompt: 1, completion: 1, turns: 1 } };
    s.saveState('u', st);
    s.addFact('other', 'fact', 'untouched', NOW);
    return s;
  };
  const chat = seed();
  chat.wipeUser('u', 'chat');
  assert.equal(chat.countMessages('u'), 0);
  assert.equal(chat.getState('u').summary, '');
  assert.equal(chat.listFacts('u').length, 1);
  assert.equal(chat.getState('u').journalOpen, true);
  const mem = seed();
  mem.wipeUser('u', 'memory');
  assert.equal(mem.listFacts('u').length, 0);
  assert.equal(mem.listSkills('u').length, 0);
  assert.equal(mem.getProfile('u').name, '');
  assert.equal(mem.listDays('u').length, 1, 'journal kept');
  assert.equal(mem.listReminders('u').length, 1, 'reminders kept');
  assert.equal(mem.getState('u').journalOpen, true);
  assert.ok(mem.getState('u').usage, 'usage history kept for the cap');
  const all = seed();
  all.wipeUser('u', 'all');
  assert.equal(all.listDays('u').length, 0);
  assert.equal(all.listNotebooks('u').length, 0);
  assert.equal(all.listReminders('u', { includeFinished: true }).length, 0);
  assert.equal(all.listSecrets('u').length, 0);
  assert.equal(all.getState('u').journalOpen, false);
  assert.equal(all.listFacts('other').length, 1, 'other users untouched');
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const fakeData = (over: Partial<DataPort> = {}): DataPort => ({
  rate: async (from, to) => ({ base: from.toUpperCase(), rates: Object.fromEntries(to.map((c) => [c.toUpperCase(), c === 'JPY' ? 129.63 : 0.86])), updated: 'Fri, 02 Oct 2026 00:02:31 +0000', source: 'open.er-api.com (ExchangeRate-API)' }),
  weather: async (place) => ({ place, country: 'Portugal', timezone: 'Europe/Lisbon', current: { tempC: 24, feelsC: 25, windKph: 12, humidity: 60, description: 'partly cloudy' }, days: [{ date: '2026-10-02', minC: 14, maxC: 26, rainMm: 1.2, rainChance: 40, description: 'light rain' }], source: 'Open-Meteo' }),
  verse: async (ref) => ({ reference: ref, text: 'Trust in the LORD with all your heart.', translation: 'World English Bible', source: 'bible-api.com' }),
  wiki: async (topic) => ({ title: topic, summary: 'Canberra is the capital city of Australia.', url: 'https://en.wikipedia.org/wiki/Canberra', source: 'Wikipedia' }),
  ...over,
});

test('data tools return exact structured answers and fail honestly', async () => {
  const ctx = ctxFor(newStore(), msg('x'), { ports: { data: fakeData() } });
  assert.match((await executeTool(call('currency_rate', { from: 'usd', to: ['JPY', 'EUR'] }), ctx)).content, /^1 USD = 129\.63 JPY\n1 USD = 0\.86 EUR\nUpdated: Fri, 02 Oct 2026/);
  assert.match((await executeTool(call('currency_rate', { from: 'USD', to: 'JPY' }), ctx)).content, /129\.63 JPY/, 'to may be a string');
  assert.match((await executeTool(call('weather', { place: 'Lisbon' }), ctx)).content, /Lisbon, Portugal now: partly cloudy, 24°C \(feels 25°C\), wind 12 km\/h, humidity 60%\.\n2026-10-02: light rain, 14–26°C, rain 1\.2 mm \(40%\)/);
  assert.match((await executeTool(call('bible_verse', { reference: 'Proverbs 3:5' }), ctx)).content, /^Proverbs 3:5 \(World English Bible\): Trust in the LORD/);
  const w = await executeTool(call('wikipedia', { topic: 'Canberra' }), ctx);
  assert.match(w.content, /^Untrusted web content follows/);
  assert.equal(ctx.tainted, true, 'wikipedia text counts as outside content');
  const broken = ctxFor(newStore(), msg('x'), { ports: { data: fakeData({ rate: async () => { throw new Error('HTTP 503 from open.er-api.com'); } }) } });
  assert.match((await executeTool(call('currency_rate', { from: 'USD', to: ['JPY'] }), broken)).content, /^Rate lookup failed: HTTP 503/);
  assert.match((await executeTool(call('weather', { place: 'x' }), ctxFor(newStore()))).content, /not available/);
});

test('web_search passes the kind; chat_search and connect_service work', async () => {
  const kinds: string[] = [];
  const ctx = ctxFor(newStore(), msg('x'), {
    ports: {
      web: fakeWeb({ search: async (_q, _n, o) => (kinds.push(o?.kind || 'web'), [{ title: 'Story', url: 'https://n.example', snippet: 'today' }]) }),
      connectLink: async (_u, service) => (service === 'onenote' ? { url: 'https://login.microsoftonline.com/x' } : { error: 'unsupported' }),
    },
  });
  await executeTool(call('web_search', { query: 'portugal', kind: 'news' }), ctx);
  await executeTool(call('web_search', { query: 'portugal' }), ctx);
  assert.deepEqual(kinds, ['news', 'web']);
  ctx.store.appendMessages('u', [{ role: 'user', content: 'the inverter broke again', at: NOW.toISOString() }]);
  assert.match((await executeTool(call('chat_search', { query: 'inverter' }), ctx)).content, /2026-10-02 they said: the inverter broke again/);
  assert.match((await executeTool(call('chat_search', { query: 'zebra' }), ctx)).content, /Nothing in our past conversation/);
  assert.match((await executeTool(call("connect_service", { service: "onenote" }), ctx)).content, /Put this exact link in your reply .*: https:\/\/login\.microsoftonline\.com\/x/);
  assert.match((await executeTool(call('connect_service', { service: 'onenote' }), ctxFor(newStore()))).content, /not set up on this server/);
});

test('approval round trip: parked on a web turn, then approved or declined by button', async () => {
  const store = newStore();
  const deps = { store, model: new ScriptedModel([]), ports: {} };
  const ctx = ctxFor(store, msg('figure it out'), { ports: { web: fakeWeb() } });
  await executeTool(call('web_fetch', { url: 'https://open.er-api.com/v6/latest/USD' }), ctx);
  await executeTool(call('skill_save', { name: 'live-rates', description: 'Get live rates', body: 'Use currency_rate.' }), ctx);
  await executeTool(call('journal_write', { text: 'Found a rates API.' }), ctx);
  store.saveState('u', ctx.state);
  const [skill, entry] = store.getState('u').approvals!;
  assert.equal(skill.label, 'Save the skill "live-rates": Get live rates');
  assert.equal(store.getSkill('u', 'live-rates'), null);
  const r = await resolveApproval(deps, 'u', skill.id, true, { now: NOW });
  assert.equal(r.found, true);
  assert.equal(r.ok, true);
  assert.match(r.content!, /Saved skill "live-rates"/);
  assert.ok(store.getSkill('u', 'live-rates'));
  const j = await resolveApproval(deps, 'u', entry.id, true, { now: NOW });
  assert.equal(j.ok, true, 'approved journal save works even with the journal closed');
  assert.equal(store.getDay('u', '2026-10-02')?.entries[0].text, 'Found a rates API.');
  assert.deepEqual((await resolveApproval(deps, 'u', skill.id, true, { now: NOW })), { found: false }, 'cannot run twice');
  const msgs = store.recentMessages('u', 10).map((m) => m.content);
  assert.ok(msgs.some((m) => m.startsWith('[approved] Save the skill')));
  // decline and expiry
  const c2 = ctxFor(store, msg('x', { forwarded: true }));
  await executeTool(call('remember', { text: 'injected fact' }), c2);
  store.saveState('u', c2.state);
  const pending = store.getState('u').approvals!.at(-1)!;
  assert.deepEqual(await resolveApproval(deps, 'u', pending.id, false, { now: NOW }), { found: true, ok: true, content: 'Declined.', label: 'Remember: "injected fact"' });
  assert.equal(store.listFacts('u').length, 0);
  const c3 = ctxFor(store, msg('x', { forwarded: true }));
  await executeTool(call('remember', { text: 'old' }), c3);
  store.saveState('u', c3.state);
  const old = store.getState('u').approvals!.at(-1)!;
  assert.deepEqual(await resolveApproval(deps, 'u', old.id, true, { now: new Date(NOW.getTime() + 25 * 3600_000) }), { found: false }, 'expired after 24h');
});

// ---------------------------------------------------------------------------
// loop additions
// ---------------------------------------------------------------------------

test('approvals requested in a turn are returned for the gateway to show', async () => {
  const h = harness(
    [
      { toolCalls: [{ name: 'web_search', args: { query: 'rates' } }] },
      { toolCalls: [{ name: 'skill_save', args: { name: 'rates', description: 'rates', body: 'b' } }] },
      (req) => (assert.match(toolResultsIn(req).at(-1)!.content, /Waiting for their approval/), { text: 'Tap approve and I will keep that recipe.' }),
    ],
    { ports: { web: fakeWeb() } }
  );
  const r = await h.turn('figure out rates yourself');
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].tool, 'skill_save');
  assert.equal(h.store.getState('u').approvals?.length, 1);
});

test('stop aborts the turn and says so; nothing is auto-saved', async () => {
  const h = harness([{ text: 'long answer', delayMs: 2000 }]);
  const st = h.store.getState('u');
  st.journalOpen = true;
  h.store.saveState('u', st);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await (await import('../../src/core/loop')).runTurn(h.deps, { userKey: 'u', inbound: msg('tell me everything'), now: NOW, signal: ac.signal });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.degraded, 'stopped');
  assert.equal(r.reply, 'Stopped.');
  assert.equal(h.store.listDays('u').length, 0);
});

test('daily token cap: usage is tracked per local day and the cap pauses honestly', async () => {
  const h = harness([{ text: 'one' }, { text: 'two' }], { config: { dailyTokenCap: 100 } });
  const r1 = await h.turn('hi');
  assert.equal(r1.reply, 'one');
  const u = h.store.getState('u').usage!['2026-10-02'];
  assert.equal(u.turns, 1);
  assert.equal(u.prompt, 100);
  const r2 = await h.turn('again');
  assert.equal(r2.degraded, 'daily_cap');
  assert.match(r2.reply, /hit today's usage limit/);
  assert.equal(h.model.calls.length, 1, 'no model call over the cap');
  const tomorrow = await h.turn('next day', { now: new Date(NOW.getTime() + 24 * 3600_000) });
  assert.equal(tomorrow.reply, 'two');
});

test('background turns get more tool rounds for research', async () => {
  const h = harness([(_r, i) => (i < 12 ? { toolCalls: [{ name: 'journal_read', args: {} }] } : { text: 'Report.' })], { repeatLast: true, config: { maxToolRounds: 3, maxToolRoundsBackground: 12 } });
  const r = await h.turn({ kind: 'scheduled', text: 'research rainwater tanks and report', media: [] });
  assert.equal(r.rounds, 12);
  assert.equal(r.reply, 'Report.');
});

test('standing instructions are repeated next to their message; approvals pending are visible', async () => {
  const h = harness([{ text: 'ok' }]);
  h.store.addFact('u', 'instruction', 'Be brief and casual', NOW);
  const st = h.store.getState('u');
  st.approvals = [{ id: 'a1', tool: 'skill_save', args: {}, label: 'Save the skill "rates"', createdAt: NOW.toISOString() }];
  h.store.saveState('u', st);
  await h.turn('hey');
  const block = lastUserText(h.model.calls[0]);
  assert.match(block, /Their standing instructions — follow them in this reply: Be brief and casual/);
  assert.match(block, /Waiting for their approval: Save the skill "rates"/);
  assert.match(block, /Voice notes: not transcribed/);
});

test('"from now on" without saving an instruction is challenged', () => {
  assert.equal(unbackedClaim('Got it. Shorter from now on.', []), 'remembered something');
  assert.equal(unbackedClaim("I'll keep it short.", []), 'remembered something');
  assert.equal(unbackedClaim('Got it. Shorter from now on.', [{ type: 'fact_saved', factId: 1 }]), null);
});

// ---------------------------------------------------------------------------
// maintenance
// ---------------------------------------------------------------------------

test('memory tidy merges duplicates conservatively', async () => {
  const store = newStore();
  const ids = ['Builds boat engines in Porto', 'Works on boat engines', 'Has two kids', 'Has 2 children', 'Likes tea', 'Lives in Porto'].map((t) => store.addFact('u', 'fact', t, NOW).fact.id);
  const ins = store.addFact('u', 'instruction', 'Be brief', NOW).fact.id;
  const model = new ScriptedModel([{ text: '```json\n' + JSON.stringify({ merge: [{ ids: [ids[0], ids[1]], text: 'Builds boat engines in Porto' }, { ids: [ids[4], ins], text: 'mixed kinds' }], remove: [ids[3], 9999] }) + '\n```' }]);
  const r = await tidyMemory({ store, model, ports: {} }, 'u', NOW);
  assert.deepEqual(r, { removed: 1, merged: 1 });
  const texts = store.listFacts('u').map((f) => f.text);
  assert.deepEqual(texts.sort(), ['Be brief', 'Builds boat engines in Porto', 'Has two kids', 'Likes tea', 'Lives in Porto'].sort());
  const kids = store.listFacts('u').filter((f) => /kids|children/i.test(f.text)).map((f) => f.id);
  store.addFact('u', 'fact', 'Has 2 kids (a boy and a girl)', NOW);
  const both = [...kids, store.listFacts('u').at(-1)!.id];
  await tidyMemory({ store, model: new ScriptedModel([{ text: JSON.stringify({ merge: [{ ids: both, text: 'Has two kids, a boy and a girl' }] }) }]), ports: {} }, 'u', NOW);
  assert.ok(store.listFacts('u').some((f) => f.text === 'Has two kids, a boy and a girl'), 'new merged sentence replaces the group');
  assert.ok(!store.listFacts('u').some((f) => f.text === 'Has two kids'));
  const big = newStore();
  for (let i = 0; i < 8; i++) big.addFact('u', 'fact', `fact number ${i}`, NOW);
  const greedy = new ScriptedModel([{ text: JSON.stringify({ remove: big.listFacts('u').map((f) => f.id) }) }]);
  assert.deepEqual(await tidyMemory({ store: big, model: greedy, ports: {} }, 'u', NOW), { removed: 0, merged: 0 }, 'refuses to touch more than half');
  assert.equal(big.listFacts('u').length, 8);
  assert.equal(await tidyMemory({ store: big, model: new ScriptedModel([{ text: 'not json' }]), ports: {} }, 'u', NOW), null);
  assert.equal(await tidyMemory({ store: big, model: new ScriptedModel([{ error: new ModelUnavailableError('down') }]), ports: {} }, 'u', NOW), null);
  const small = newStore();
  small.addFact('u', 'fact', 'one', NOW);
  assert.equal(await tidyMemory({ store: small, model: new ScriptedModel([]), ports: {} }, 'u', NOW), null);
});

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

test('data port parses the real API shapes and reports errors', async () => {
  const routes: Record<string, unknown> = {
    'https://open.er-api.com/v6/latest/USD': { result: 'success', rates: { JPY: 129.63, EUR: 0.86 }, time_last_update_utc: 'Fri, 02 Oct 2026 00:02:31 +0000' },
    'https://geocoding-api.open-meteo.com/': { results: [{ name: 'Porto', country: 'Portugal', admin1: 'Porto', latitude: 41.15, longitude: -8.61, timezone: 'Europe/Lisbon' }] },
    'https://api.open-meteo.com/': {
      timezone: 'Europe/Lisbon',
      current: { temperature_2m: 27, apparent_temperature: 29, relative_humidity_2m: 55, wind_speed_10m: 9, weather_code: 61 },
      daily: { time: ['2026-10-02'], temperature_2m_min: [17], temperature_2m_max: [29], precipitation_sum: [3.4], precipitation_probability_max: [70], weather_code: [80] },
    },
    'https://bible-api.com/': { reference: 'Proverbs 3:5', text: 'Trust in Yahweh with all your heart,\n', translation_name: 'World English Bible' },
    'https://en.wikipedia.org/w/rest.php/': { pages: [{ key: 'Canberra', title: 'Canberra' }] },
    'https://en.wikipedia.org/api/rest_v1/': { title: 'Canberra', extract: 'Canberra is the capital city of Australia.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Canberra' } } },
  };
  const data = createDataPort({
    fetchImpl: async (input: string | URL | Request) => {
      const u = String(input);
      const key = Object.keys(routes).find((k) => u.startsWith(k));
      return key ? Response.json(routes[key]) : new Response('nope', { status: 404 });
    },
  });
  assert.deepEqual((await data.rate('usd', ['jpy'])).rates, { JPY: 129.63 });
  await assert.rejects(data.rate('dollars', ['JPY']), /3-letter/);
  await assert.rejects(data.rate('USD', ['XXX']), /no rate/);
  const w = await data.weather('Porto');
  assert.equal(w.current.description, 'light rain');
  assert.equal(w.days[0].description, 'light showers');
  assert.equal(w.place, 'Porto, Porto');
  assert.equal((await data.verse('Proverbs 3:5')).text, 'Trust in Yahweh with all your heart,');
  assert.equal((await data.wiki('capital of australia')).title, 'Canberra');
  const empty = createDataPort({ fetchImpl: async () => Response.json({ results: [] }) });
  await assert.rejects(empty.weather('Nowhere'), /could not find a place/);
});

test('speech-to-text posts the audio and returns text; failures return null; keys pick the provider', async () => {
  assert.equal(senseFromKeys({}), null);
  assert.equal(senseFromKeys({ groq: 'g' })?.name, 'groq');
  assert.equal(senseFromKeys({ openai: 'o' })?.model, 'whisper-1');
  assert.equal(senseFromKeys({ groq: 'g', openai: 'o' })?.name, 'groq');
  let seen: { auth?: string; ctype?: string; size: number } = { size: 0 };
  const srv = http.createServer(async (req, res) => {
    let n = 0;
    for await (const c of req) n += (c as Buffer).length;
    seen = { auth: req.headers.authorization, ctype: req.headers['content-type'], size: n };
    if (req.url === '/fail') {
      res.writeHead(401);
      res.end('bad key SECRETKEY');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: ' Remind me to call mum. ' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  const file = path.join(dir, 'v.oga');
  fs.writeFileSync(file, Buffer.from('OggS fake audio'));
  try {
    const warns: string[] = [];
    const ok = createSense({ name: 'groq', url: base + '/ok', key: 'SECRETKEY', model: 'whisper-large-v3-turbo' });
    assert.equal(await ok.transcribe(file, 'audio/ogg'), 'Remind me to call mum.');
    assert.equal(seen.auth, 'Bearer SECRETKEY');
    assert.match(seen.ctype || '', /multipart\/form-data/);
    assert.ok(seen.size > 15);
    const bad = createSense({ name: 'groq', url: base + '/fail', key: 'SECRETKEY', model: 'm' }, { log: { info() {}, warn: (m, d) => warns.push(m + JSON.stringify(d)), error() {} } });
    assert.equal(await bad.transcribe(file), null);
    assert.ok(warns.length && !warns.join('').includes('SECRETKEY'), 'key redacted from logs');
    assert.equal(await ok.transcribe(path.join(dir, 'missing.ogg')), null);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('web search: news first when asked, cached for 10 minutes, rate-limited providers rest', async () => {
  let clock = 0;
  const calls: string[] = [];
  const web = createWebPort({
    now: () => clock,
    fetchImpl: async (input: string | URL | Request) => {
      const u = String(input);
      calls.push(new URL(u).hostname);
      if (u.startsWith('https://news.google.com/')) return new Response('<rss><item><title>Fresh story</title><link>https://n.example/1</link></item></rss>');
      if (u.startsWith('https://search.brave.com/')) return new Response('slow down', { status: 429 });
      if (u.startsWith('https://en.wikipedia.org/')) return Response.json({ pages: [{ title: 'Portugal', key: 'Portugal', description: 'Country' }] });
      return new Response('x', { status: 500 });
    },
  });
  assert.equal((await web.search('portugal', 3, { kind: 'news' }))[0].title, 'Fresh story');
  assert.equal(calls[0], 'news.google.com');
  calls.length = 0;
  await web.search('portugal', 3, { kind: 'news' });
  assert.equal(calls.length, 0, 'served from cache');
  const r = await web.search('lisbon', 3);
  assert.equal(r[0].title, 'Portugal');
  assert.ok(calls.includes('search.brave.com'));
  calls.length = 0;
  await web.search('mombasa', 3);
  assert.ok(!calls.includes('search.brave.com'), 'brave rests after a 429');
  clock += 11 * 60_000;
  calls.length = 0;
  await web.search('porto', 3);
  assert.ok(calls.includes('search.brave.com'), 'tried again after the rest');
});

// ---------------------------------------------------------------------------
// nothing personal in code: deployment settings and the person's memory decide
// ---------------------------------------------------------------------------

test('timezone: the person\'s own, else the deployment default, else UTC', async () => {
  const lastContext = (model: ScriptedModel) => lastUserText(model.calls.at(-1)!);
  const bare = newStore();
  const m1 = new ScriptedModel([{ text: 'hi' }]);
  await runTurn({ store: bare, model: m1, ports: {} }, { userKey: 'u', inbound: msg('hey'), now: NOW });
  assert.match(lastContext(m1), /^<context>\nNow: Fri 2 Oct 2026, 12:02 \(Friday, UTC\)/);
  assert.match(String(m1.calls[0].messages[1].content), /Timezone: \(not told yet; using UTC until they say\)/);

  const m2 = new ScriptedModel([{ text: 'hi' }]);
  await runTurn({ store: newStore(), model: m2, ports: {}, config: { defaultTimezone: 'America/New_York' } }, { userKey: 'u', inbound: msg('hey'), now: NOW });
  assert.match(lastContext(m2), /08:02 \(Friday, America\/New_York\)/);

  const own = newStore();
  own.saveProfile('u', { name: '', agentName: '', timezone: 'Asia/Tokyo' });
  const m3 = new ScriptedModel([{ text: 'hi' }]);
  await runTurn({ store: own, model: m3, ports: {}, config: { defaultTimezone: 'America/New_York' } }, { userKey: 'u', inbound: msg('hey'), now: NOW });
  assert.match(lastContext(m3), /21:02 \(Friday, Asia\/Tokyo\)/);

  const m4 = new ScriptedModel([{ text: 'hi' }]);
  await runTurn({ store: newStore(), model: m4, ports: {}, config: { defaultTimezone: 'Not/AZone' } }, { userKey: 'u', inbound: msg('hey'), now: NOW });
  assert.match(lastContext(m4), /\(Friday, UTC\)/, 'an invalid deployment timezone falls back to UTC');
});

test('local news region comes from the model, never from code', async () => {
  const seen: Array<string | undefined> = [];
  const ctx = ctxFor(newStore(), msg('x'), { ports: { web: fakeWeb({ search: async (_q, _n, o) => (seen.push(o?.region), []) }) } });
  await executeTool(call('web_search', { query: 'elections', kind: 'news', region: 'gb' }), ctx);
  await executeTool(call('web_search', { query: 'elections', kind: 'news' }), ctx);
  await executeTool(call('web_search', { query: 'elections', kind: 'news', region: 'Britain' }), ctx);
  assert.deepEqual(seen, ['GB', undefined, undefined]);
  assert.equal(newsUrl('rain today'), 'https://news.google.com/rss/search?q=rain%20today&hl=en');
  assert.equal(newsUrl('rain today', 'JP'), 'https://news.google.com/rss/search?q=rain%20today&hl=en-JP&gl=JP&ceid=JP:en');
  assert.doesNotMatch(newsUrl('x', 'jp; drop'), /gl=/);
});

test('web port builds news URLs per call from the region it was given', async () => {
  const urls: string[] = [];
  const rss = fs.readFileSync(path.join(__dirname, '../fixtures/news.rss'), 'utf8');
  const web = createWebPort({ fetchImpl: async (input: string | URL | Request) => (urls.push(String(input)), new Response(rss, { headers: { 'content-type': 'application/rss+xml' } })) });
  await web.search('harbour', 3, { kind: 'news', region: 'PT' });
  await web.search('harbour', 3, { kind: 'news' });
  const news = urls.filter((u) => u.includes('news.google.com'));
  assert.ok(news.some((u) => /gl=PT&ceid=PT:en/.test(u)), news.join('\n'));
  assert.ok(news.some((u) => !/gl=/.test(u)), 'no region, no country');
});

test('currency lookups need the target currencies (no assumed home currency)', async () => {
  const data = createDataPort({ fetchImpl: async () => Response.json({ result: 'success', rates: { EUR: 0.86, JPY: 147.2 }, time_last_update_utc: 'x' }) });
  await assert.rejects(data.rate('USD', []), /which currencies/);
  assert.deepEqual((await data.rate('USD', ['jpy'])).rates, { JPY: 147.2 });
});
