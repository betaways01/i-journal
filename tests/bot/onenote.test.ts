import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createOneNoteService } from '../../src/bot/person/onenoteService';
import { createCore } from '../../src/core';
import { createSweeper } from '../../src/core/sweeper';
import { ScriptedModel } from '../../src/core/testing/scriptedModel';
import { JournalDay } from '../../src/core/types';
import { runMigrations } from '../../src/db';
import { createOneNoteClient } from '../../src/onenote/client';
import { createMicrosoftAuth, ReconnectNeeded } from '../../src/onenote/oauth';
import { sqliteTokenStore } from '../../src/onenote/tokens';
import { markdownToOneNote } from '../../src/onenote/xhtml';
import { createFakeMicrosoft, FakeMicrosoftOptions } from '../support/fakeMicrosoft';
import { newStore, NOW } from '../core/helpers';

const USER = '100000001';
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function appDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  const t = new Date().toISOString();
  db.prepare('INSERT INTO users (telegram_id, is_owner, onboarding_complete, created_at, updated_at) VALUES (?, 1, 1, ?, ?)').run(USER, t, t);
  return db;
}

function setup(fakeOpts: FakeMicrosoftOptions = {}, opts: { redirect?: string; preferLink?: boolean } = {}) {
  const fake = createFakeMicrosoft(fakeOpts);
  const db = appDb();
  const notices: string[] = [];
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push('WARN ' + m), error: (m: string) => logs.push('ERROR ' + m) };
  const connected: string[] = [];
  const svc = createOneNoteService({
    db,
    app: { clientId: fake.clientId, clientSecret: fake.clientSecret, tenant: 'common', redirectUri: opts.redirect ?? 'https://bot.example/auth/callback' },
    preferLink: opts.preferLink ?? true,
    stateSecret: 'state-secret',
    log,
    notify: async (_k, m) => void notices.push(m),
    onConnected: (k) => connected.push(k),
    fetchImpl: fake.fetchImpl,
    devicePollMs: 5,
    now: fake.now,
    sleep: async () => undefined,
  });
  return { fake, db, svc, notices, logs, connected, lib: svc.library! };
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function connectByLink(s: ReturnType<typeof setup>) {
  const offer = await s.svc.offer(USER);
  assert.ok('url' in offer && !('code' in offer));
  const { code, state } = s.fake.signInVia((offer as { url: string }).url);
  return s.svc.completeLink(state, code);
}

const day = (date: string, entries: JournalDay['entries'], extra: Partial<JournalDay> = {}): JournalDay => ({ date, weekday: 'Friday', entries, updatedAt: '', rev: 1, syncedRev: 0, ...extra });
const entry = (text: string, media: JournalDay['entries'][number]['media'] = []) => ({ id: 1, localTime: '10:00', text, media, at: NOW.toISOString() });

test('link sign-in (Web registration): PKCE, OneNote probe, stored connection, person told in the chat', async () => {
  const s = setup();
  const offer = await s.svc.offer(USER);
  const url = new URL((offer as { url: string }).url);
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((url.searchParams.get('code_challenge') || '').length >= 43);
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  const { code, state } = s.fake.signInVia(url.toString());
  const r = await s.svc.completeLink(state, code);
  assert.deepEqual(r, { ok: true, title: 'OneNote connected', message: 'You can go back to Telegram now.' });
  assert.match(s.notices[0], /✅ OneNote connected \(Test Person, person@outlook\.com\)/);
  assert.match(s.notices[0], /i-Journal \/ Daily Entries/);
  assert.deepEqual(s.connected, [USER]);
  assert.equal(s.lib.isConnected(USER), true);
  assert.equal(sqliteTokenStore(s.db).get(1)?.meta.mode, 'web');
  assert.ok(s.fake.calls.some((c) => c.url.startsWith('/v1.0/me/onenote/notebooks')), 'OneNote was probed before counting as connected');
  assert.deepEqual(await s.svc.completeLink(state, code), { ok: false, title: 'OneNote was not connected', message: 'That sign-in link was already used or has expired. Ask for a new one.' });
  assert.equal((await s.svc.completeLink(state.replace(/.$/, 'x'), code)).ok, false, 'tampered state refused');
  const lines = (await s.svc.storageLines(USER)).join('\n');
  assert.match(lines, /OneNote: connected \(Test Person, person@outlook\.com\)/);
});

test('single-page-app registration is detected and handled; its 24-hour sign-in ends in one honest notice', async () => {
  const s = setup({ registration: 'spa' });
  assert.equal((await connectByLink(s)).ok, true);
  assert.equal(sqliteTokenStore(s.db).get(1)?.meta.mode, 'spa');
  assert.ok(s.logs.some((l) => /single-page app in Azure/.test(l)), 'operator warned about the 24h limit');
  assert.equal((await s.lib.syncDay(USER, day('2026-10-02', [entry('One')]), '# Friday\n- 10:00 — One')).ok, true);

  s.fake.advance(25 * 3_600_000);
  const r1 = await s.lib.syncDay(USER, day('2026-10-03', [entry('Two')]), '# Saturday\n- 10:00 — Two');
  assert.equal(r1.ok, false);
  assert.equal(r1.permanent, true);
  assert.match(r1.error || '', /24 hours/);
  assert.equal(s.lib.isConnected(USER), false, 'stops trying until they connect again');
  const r2 = await s.lib.syncDay(USER, day('2026-10-03', [entry('Two')]), 'x');
  assert.equal(r2.permanent, true);
  assert.equal(s.notices.filter((n) => /OneNote stopped taking copies/.test(n)).length, 1, 'told once');
  assert.match((await s.svc.storageLines(USER)).join('\n'), /needs signing in again/);

  // Connecting again clears it.
  assert.equal((await connectByLink(s)).ok, true);
  assert.equal(s.lib.isConnected(USER), true);
  assert.equal((await s.lib.syncDay(USER, day('2026-10-03', [entry('Two')]), '# Saturday')).ok, true);
});

test('code sign-in: works without a public address, finishes in the background, tells the person', async () => {
  const s = setup({ publicClientFlows: true }, { preferLink: false });
  const offer = await s.svc.offer(USER);
  assert.deepEqual(offer, { url: 'https://microsoft.com/devicelogin', code: 'ABCD-1234', expiresInMin: 15 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.lib.isConnected(USER), false, 'pending until they enter the code');
  s.fake.approveDevice();
  await waitFor(() => s.notices.length > 0);
  assert.match(s.notices[0], /✅ OneNote connected/);
  assert.equal(sqliteTokenStore(s.db).get(1)?.meta.mode, 'public');
  assert.equal(sqliteTokenStore(s.db).get(1)?.meta.via, 'device');
  assert.equal(s.lib.isConnected(USER), true);

  s.fake.advance(2 * 3_600_000);
  assert.equal((await s.lib.syncDay(USER, day('2026-10-02', [entry('One')]), '# Friday')).ok, true, 'renews with the public-client shape');
});

test('code sign-in declined or switched off: honest messages and the right fallback', async () => {
  const declined = setup({ publicClientFlows: true }, { preferLink: false });
  await declined.svc.offer(USER);
  declined.fake.declineDevice();
  await waitFor(() => declined.notices.length > 0);
  assert.match(declined.notices[0], /OneNote was not connected: You cancelled the sign-in\./);

  const remote = setup({ publicClientFlows: false }, { preferLink: false, redirect: 'https://bot.example/auth/callback' });
  const o1 = await remote.svc.offer(USER);
  assert.ok('url' in o1 && !('code' in o1) && !('note' in o1 && o1.note), 'falls back to the link');

  const local = setup({ publicClientFlows: false }, { preferLink: false, redirect: 'http://localhost:3002/auth/callback' });
  const o2 = (await local.svc.offer(USER)) as { url: string; note?: string };
  assert.match(o2.url, /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize/);
  assert.match(o2.note || '', /only works on the computer the bot is running on/);
});

test('guest sign-ins and accounts without OneNote are refused with a clear reason, nothing stored', async () => {
  const guest = setup({ upn: 'person_outlook.com#EXT#@company.onmicrosoft.com' });
  const r1 = await connectByLink(guest);
  assert.equal(r1.ok, false);
  assert.match(r1.message, /guest of an organization/);
  assert.equal(sqliteTokenStore(guest.db).get(1), null);
  assert.match(guest.notices[0], /OneNote was not connected: You signed in as a guest/);

  const nolicense = setup({ noLicense: true });
  const r2 = await connectByLink(nolicense);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /no SharePoint\/OneDrive license/);
  assert.equal(sqliteTokenStore(nolicense.db).get(1), null);
});

test('journal pages are created once and updated in place; photos go up once; a deleted page is rewritten', async () => {
  const s = setup();
  await connectByLink(s);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ij-photo-'));
  const photo = path.join(dir, 'p.jpg');
  fs.writeFileSync(photo, Buffer.alloc(2048, 7));

  const r1 = await s.lib.syncDay(USER, day('2026-10-02', [entry('Morning <coffee> & plans')]), '# Friday 2026-10-02\n- 10:00 — Morning <coffee> & plans');
  assert.equal(r1.ok, true);
  assert.equal(s.fake.notebooks[0].displayName, 'i-Journal');
  assert.equal(s.fake.sections[0].displayName, 'Daily Entries');
  assert.equal(s.fake.pages.length, 1);
  const page = s.fake.pages[0];
  assert.equal(page.title, '2026-10-02 — Friday');
  assert.match(page.text || '', /Morning &lt;coffee&gt; &amp; plans/);
  assert.equal(r1.remoteUrl, `https://onenote.example/${page.id}`);

  const withPhoto = day('2026-10-02', [entry('Morning'), entry('Sunset', [{ kind: 'photo', fileId: 'f1', localPath: photo, mime: 'image/jpeg' }])], { remotePageId: r1.remotePageId });
  assert.equal((await s.lib.syncDay(USER, withPhoto, '# Friday\n- 10:00 — Morning\n- 18:00 — Sunset [photo]')).ok, true);
  assert.equal(s.fake.pages.length, 1, 'same page, updated in place');
  assert.match(page.text || '', /Sunset/);
  assert.equal(page.images.length, 1);
  assert.equal(page.images[0].bytes, 2048);
  await s.lib.syncDay(USER, withPhoto, '# Friday\n- 10:00 — Morning\n- 18:00 — Sunset [photo]\n- 21:00 — Night');
  assert.equal(page.images.length, 1, 'a photo is uploaded once');

  s.fake.pages.splice(0, 1);
  const r3 = await s.lib.syncDay(USER, withPhoto, '# Friday\n- again');
  assert.equal(r3.ok, true);
  assert.notEqual(r3.remotePageId, r1.remotePageId, 'rewritten when the remembered page is gone');
  assert.equal(s.fake.pages.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a page made by the old app is adopted, keeping what it had', async () => {
  const s = setup();
  await connectByLink(s);
  const old = s.fake.addForeignPage('i-Journal', 'Daily Entries', '2026-09-29 — Tuesday', '<p>Written by the old app</p>');
  const r = await s.lib.syncDay(USER, day('2026-09-29', [entry('Added later')], { weekday: 'Tuesday' }), '# Tuesday\n- 10:00 — Added later');
  assert.equal(r.ok, true);
  assert.equal(r.remotePageId, old.id);
  assert.deepEqual(old.appended, ['<p>Written by the old app</p>']);
  assert.match(old.text || '', /Added later/);
  assert.equal(s.fake.pages.length, 1);
});

test('notes go to their own notebook and section (names made safe); search and read existing OneNote pages', async () => {
  const s = setup();
  await connectByLink(s);
  const note = { id: 3, notebook: 'Work: Plans/2026', section: '', title: 'Q4 goals', body: '**Ship it**\n\n> keep it small', createdAt: '', updatedAt: '', rev: 1, syncedRev: 0 };
  assert.equal((await s.lib.syncNote(USER, note)).ok, true);
  assert.equal(s.fake.notebooks.find((n) => n.displayName.startsWith('Work'))?.displayName, 'Work- Plans-2026');
  assert.equal(s.fake.sections.at(-1)?.displayName, 'Notes');
  const p = s.fake.pages.at(-1)!;
  assert.match(p.text || '', /<b>Ship it<\/b>/);

  s.fake.addForeignPage('Study Group', 'Leadership', 'Trust first', '<p>Trust is the <b>foundation</b>.</p>');
  const hits = await s.lib.search(USER, 'leadership trust', 5);
  assert.equal(hits[0].path, 'Study Group / Leadership / Trust first');
  assert.match(hits[0].url || '', /^https:\/\/onenote\.example\//);
  const read = await s.lib.read(USER, hits[0].ref);
  assert.equal(read?.text, 'Trust is the foundation .');
  assert.equal(await s.lib.read(USER, 'remote:missing'), null);
});

test('throttling, a revoked token and Microsoft hiccups are retried; the journal location can move', async () => {
  const s = setup();
  await connectByLink(s);
  s.fake.fail(/POST .*\/pages$/, 429, 1);
  s.fake.fail(/GET .*\/notebooks$/, 503);
  assert.equal((await s.lib.syncDay(USER, day('2026-10-02', [entry('One')]), '# One')).ok, true);
  s.fake.revokeAccessTokens();
  assert.equal((await s.lib.syncDay(USER, day('2026-10-03', [entry('Two')]), '# Two')).ok, true, 'refreshes and retries after a 401');

  const placed = await s.lib.setJournalTarget!(USER, 'Life', 'Days');
  assert.deepEqual(placed, { notebook: 'Life', section: 'Days' });
  assert.deepEqual(s.lib.journalTarget!(USER), { notebook: 'Life', section: 'Days' });
  await s.lib.syncDay(USER, day('2026-10-04', [entry('Three')]), '# Three');
  const sec = s.fake.sections.find((x) => x.id === s.fake.pages.at(-1)!.sectionId)!;
  assert.equal(sec.displayName, 'Days');
});

test('access token refresh: renewed before expiry, concurrent callers share one refresh, dead grants stop', async () => {
  const fake = createFakeMicrosoft();
  const db = appDb();
  const tokens = sqliteTokenStore(db);
  const auth = createMicrosoftAuth({ app: { clientId: fake.clientId, clientSecret: fake.clientSecret, tenant: 'common', redirectUri: 'https://bot.example/auth/callback' }, db, tokens, stateSecret: 'x', fetchImpl: fake.fetchImpl, now: fake.now });
  const { code, state } = fake.signInVia(auth.buildLink(1));
  await auth.completeLink(state, code);
  const first = await auth.accessToken(1);
  assert.equal(await auth.accessToken(1), first, 'reused while fresh');
  fake.advance(59 * 60_000);
  const [a, b] = await Promise.all([auth.accessToken(1), auth.accessToken(1)]);
  assert.equal(a, b);
  assert.notEqual(a, first, 'renewed two minutes early');
  assert.equal(fake.calls.filter((c) => c.url.endsWith('/token')).length, 2, 'one exchange + one shared refresh');

  tokens.put(1, { ...tokens.get(1)!, refreshToken: 'unknown', expiresAt: new Date(fake.now() - 1000).toISOString() });
  await assert.rejects(auth.accessToken(1), (e) => e instanceof ReconnectNeeded && /expired/.test(e.reason));
  assert.equal(auth.status(1).connected, false);
  await assert.rejects(auth.accessToken(1), ReconnectNeeded);
  assert.equal(fake.calls.filter((c) => c.url.endsWith('/token')).length, 3, 'no more attempts once marked');

  // A link older than 15 minutes is refused.
  const late = fake.signInVia(auth.buildLink(1));
  fake.advance(16 * 60_000);
  await assert.rejects(auth.completeLink(late.state, late.code), /expired/);
});

test('the sweeper copies once connected, records page ids, and backs off 1, 2, 4 minutes on failures', async () => {
  const s = setup();
  const store = newStore();
  const core = createCore({ store, model: new ScriptedModel([]), ports: { library: s.lib } });
  let clock = new Date('2026-10-02T12:00:00Z');
  const warnings: string[] = [];
  const sweeper = createSweeper({
    core,
    now: () => clock,
    canDeliver: () => true,
    enqueue: async (_u, job) => job(),
    deliver: async () => undefined,
    sync: true,
    log: { info: () => undefined, warn: (m, d) => warnings.push(`${m} ${JSON.stringify(d)}`), error: (m, d) => warnings.push(`${m} ${JSON.stringify(d)}`) },
  });
  store.addEntry(USER, '2026-10-01', { text: 'Yesterday', media: [], at: NOW, localTime: '20:00' });
  store.addEntry(USER, '2026-10-02', { text: 'Today', media: [], at: NOW, localTime: '10:00' });
  store.saveNote(USER, { notebook: 'Personal', section: 'Money', title: 'Rules', body: 'Pay yourself first' }, NOW);
  await sweeper.tick();
  assert.equal(s.fake.pages.length, 0, 'nothing until connected');
  await connectByLink(s);
  await sweeper.tick();
  assert.equal(s.fake.pages.length, 3);
  assert.deepEqual(store.dirtyDays(USER), []);
  assert.deepEqual(store.dirtyNotes(USER), []);
  assert.ok(store.getDay(USER, '2026-10-01')?.remotePageId);

  store.addEntry(USER, '2026-10-02', { text: 'Evening', media: [], at: NOW, localTime: '21:00' });
  for (let i = 0; i < 3; i++) s.fake.fail(/PATCH/, 500);
  await sweeper.tick();
  assert.equal(store.dirtyDays(USER).length, 1, 'still dirty after a failure');
  assert.match(warnings.at(-1) || '', /"retryInMin":1/);
  clock = new Date(clock.getTime() + 61_000);
  await sweeper.tick();
  assert.match(warnings.at(-1) || '', /"retryInMin":2/);
  clock = new Date(clock.getTime() + 30_000);
  await sweeper.tick();
  assert.equal(warnings.filter((w) => /onenote copy failed/.test(w)).length, 2, 'resting');
  clock = new Date(clock.getTime() + 2 * 60_000);
  await sweeper.tick();
  assert.match(warnings.at(-1) || '', /"retryInMin":4/);
  clock = new Date(clock.getTime() + 5 * 60_000);
  await sweeper.tick();
  assert.deepEqual(store.dirtyDays(USER), [], 'copied once Microsoft answers again');
  assert.match(s.fake.pages.find((p) => p.title.startsWith('2026-10-02'))?.text || '', /Evening/);
});

test('Markdown becomes OneNote XHTML: paragraphs, quotes, code, links, escaping', () => {
  const x = markdownToOneNote('# Friday\n\n- 10:00 — tea & <toast>\n**bold** _it_ ~~gone~~ `code`\n\n> quoted\n> twice\n\n```\na < b\nc\n```\n[link](https://example.com/?a=1&b=2) ||secret||');
  assert.equal(
    x,
    '<p><b>Friday</b></p><p>• 10:00 — tea &amp; &lt;toast&gt;</p><p><b>bold</b> <i>it</i> <del>gone</del> <span style="font-family:Consolas,monospace">code</span></p>' +
      '<div style="margin-left:16px;color:#595959">quoted<br/>twice</div><pre>a &lt; b<br/>c</pre><p><a href="https://example.com/?a=1&amp;b=2">link</a> secret</p>'
  );
});

test('OneNote client classifies errors so callers know whether to retry', async () => {
  const fake = createFakeMicrosoft({ noLicense: true });
  const db = appDb();
  const auth = createMicrosoftAuth({ app: { clientId: fake.clientId, clientSecret: fake.clientSecret, tenant: 'common', redirectUri: 'https://bot.example/auth/callback' }, db, tokens: sqliteTokenStore(db), stateSecret: 'x', fetchImpl: fake.fetchImpl, now: fake.now });
  const client = createOneNoteClient({ token: () => auth.accessToken(1), fetchImpl: fake.fetchImpl, sleep: async () => undefined });
  await assert.rejects(client.whoami(1), (e: Error & { kind?: string }) => e.kind === 'reconnect', 'not connected');
  sqliteTokenStore(db).put(1, { accessToken: 'bogus', refreshToken: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), meta: {} });
  await assert.rejects(client.whoami(1), (e: Error & { kind?: string }) => e.kind === 'reconnect', 'a token Graph rejects twice');
});
