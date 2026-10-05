/**
 * Live evaluation of the person harness against the real model.
 *   npm run eval:live            (runs every scenario 3 times)
 *   EVAL_RUNS=1 EVAL_ONLY=soak npm run eval:live
 * Checks effects, stored state and key facts in replies — never exact wording.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });
import { createCore, createModelClient, providersFromEnv, SqliteStore } from '../../src/core';
import { runDirectTool } from '../../src/core/commands';
import { uncitedPaths } from '../../src/core/loop';
import { localParts, zonedToUtc, shiftDate } from '../../src/core/time';
import { Inbound, TurnResult } from '../../src/core/types';
import { createWebPort } from '../../src/core/ports/web';
import { createDataPort } from '../../src/core/ports/data';

const TZ = 'Asia/Riyadh';
const RUNS = Number(process.env.EVAL_RUNS || 3);
const ONLY = process.env.EVAL_ONLY || '';

type Check = { name: string; ok: boolean; detail?: string };
interface Ctx {
  store: SqliteStore;
  core: ReturnType<typeof createCore>;
  user: string;
  log: string[];
  turn(text: string | Inbound): Promise<TurnResult>;
  check(name: string, ok: boolean, detail?: string): void;
  today(): string;
}

function makeCtx(scenario: string, run: number): Ctx & { checks: Check[] } {
  const store = new SqliteStore(new Database(':memory:'));
  const core = createCore({
    store,
    model: createModelClient({ providers: providersFromEnv() }),
    ports: { web: createWebPort(), data: createDataPort(), connectLink: async () => ({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?eval=1' }) },
  });
  const user = `${scenario}-${run}`;
  const checks: Check[] = [];
  const log: string[] = [];
  return {
    store,
    core,
    user,
    log,
    checks,
    today: () => localParts(new Date(), TZ).date,
    check(name, ok, detail) {
      checks.push({ name, ok, detail });
      if (!ok) log.push(`   ✗ ${name}${detail ? ' — ' + detail : ''}`);
    },
    async turn(input) {
      const inbound: Inbound = typeof input === 'string' ? { kind: 'message', text: input, media: [] } : input;
      const t0 = Date.now();
      const r = await core.runTurn({ userKey: user, inbound, timezone: TZ });
      const label = inbound.text || inbound.media.map((m) => `[${m.kind}]`).join(' ');
      log.push(`>>> ${label}`);
      log.push(`<<< ${r.reply.replace(/\n/g, '\n    ')}`);
      log.push(`    [${Date.now() - t0}ms tools=${r.trace.map((x) => x.tool + (x.ok ? '' : '!')).join(',') || '-'}${r.corrections.length ? ' corrections=' + r.corrections : ''}${r.degraded ? ' DEGRADED=' + r.degraded : ''}]`);
      await core.compact(user).catch(() => undefined);
      return r;
    },
  };
}

const lower = (s: string) => s.toLowerCase();
const has = (s: string, ...words: string[]) => words.every((w) => lower(s).includes(lower(w)));
const any = (s: string, ...words: string[]) => words.some((w) => lower(s).includes(lower(w)));
const journalCount = (c: Ctx) => c.store.listDays(c.user).reduce((n, d) => n + d.entries, 0);
const claimsOneNote = (s: string) => /onenote/i.test(s) && /\b(saved|synced|added|copied|stored|is in|it'?s in|now in)\b/i.test(s) && !/\b(not|n't|isn't|never|once|when)\b/i.test(s);

const scenarios: Record<string, (c: Ctx) => Promise<void>> = {
  async conversation(c) {
    let r = await c.turn('hey');
    c.check('hello: replies', r.reply.length > 0 && !r.degraded);
    r = await c.turn('my name is Sam, I build boat engines in Porto');
    c.check('learns name', lower(c.store.getProfile(c.user).name) === 'sam', JSON.stringify(c.store.getProfile(c.user)));
    c.check('learns work', c.store.listFacts(c.user).some((f) => any(f.text, 'boat', 'engine', 'porto')), JSON.stringify(c.store.listFacts(c.user).map((f) => f.text)));
    r = await c.turn("what's a good way to think about pricing a new product?");
    c.check('pricing: real answer', r.reply.length > 300, `${r.reply.length} chars`);
    r = await c.turn('write me a python function that returns the sum of odd numbers in a list');
    c.check('code: python function', /```/.test(r.reply) && /def \w+\(/.test(r.reply) && /%\s*2/.test(r.reply));
    r = await c.turn('sing me a short lullaby');
    c.check('lullaby: has verse lines', r.reply.split('\n').filter((l) => l.trim()).length >= 3);
    c.check('lullaby: not journaled', journalCount(c) === 0);
    r = await c.turn("what's my name and what do I do?");
    c.check('recall name + work', has(r.reply, 'sam') && any(r.reply, 'boat', 'engine'));
    const before = Date.now();
    r = await c.turn('remind me in 2 minutes to drink water');
    const rem = c.store.listReminders(c.user)[0];
    const delta = rem ? new Date(rem.fireAt).getTime() - before : NaN;
    c.check('reminder in 2 minutes', Boolean(rem) && Math.abs(delta - 120_000) < 90_000, rem ? `fires in ${Math.round(delta / 1000)}s: ${rem.text}` : 'no reminder');
    r = await c.turn("let's journal");
    c.check('journal opens', c.store.getState(c.user).journalOpen);
    r = await c.turn('Long day. Site visit ran over, the pump controller failed twice, and I snapped at Jordan. Felt bad after.');
    c.check('day on the page', journalCount(c) >= 1 && JSON.stringify(c.store.getDay(c.user, c.today())).toLowerCase().includes('jordan'));
    r = await c.turn('what did I just tell you about Jordan?');
    c.check('recall Jordan', any(r.reply, 'jordan', 'him') && any(r.reply, 'snap', 'bad', 'felt'));
    const entries = journalCount(c);
    r = await c.turn("that's it");
    c.check('journal closes', !c.store.getState(c.user).journalOpen);
    const day = c.store.getDay(c.user, c.today());
    c.check('wrap has a reflection', Boolean(day?.reflection), day?.reflection || 'none');
    c.check('reflection is not third person', !/\bsam (snapped|felt|had)\b/i.test(day?.reflection || ''), day?.reflection);
    r = await c.turn("what's the capital of Australia and roughly how many people live there?");
    c.check('Canberra', has(r.reply, 'canberra'));
    r = await c.turn('explain how a mortgage amortization works, in detail');
    c.check('long detailed answer', r.reply.length > 1200, `${r.reply.length} chars`);
    c.check('answer not cut off', /[.!?)`*]\s*$/.test(r.reply.trim()));
    r = await c.turn('thanks, good night');
    c.check('good night writes nothing', journalCount(c) === entries);
  },

  async soak(c) {
    const now = new Date();
    let r = await c.turn('remind me in an hour to stretch');
    const stretch = c.store.listReminders(c.user).find((x) => any(x.text, 'stretch'));
    const d = stretch ? new Date(stretch.fireAt).getTime() - now.getTime() : NaN;
    c.check('reminder in an hour', Boolean(stretch) && Math.abs(d - 3600_000) < 120_000, stretch ? `${Math.round(d / 60000)} min` : 'none');
    r = await c.turn('also remind me at 7pm to call mum');
    const mum = c.store.listReminders(c.user).find((x) => any(x.text, 'mum', 'mom', 'mother'));
    const lp = localParts(now, TZ);
    const expected = zonedToUtc(lp.hour >= 19 ? shiftDate(lp.date, 1) : lp.date, 19, 0, TZ).toISOString();
    c.check('reminder at 7pm local', mum?.fireAt === expected, `${mum?.fireAt} vs ${expected}`);

    r = await c.turn("Long day today. The client meeting went badly and I'm completely drained.");
    c.check('chat dump not silently saved', journalCount(c) === 0);
    c.check('responds to the person first', r.reply.length > 40);
    r = await c.turn('yes, put it on the page');
    c.check('saved after yes', journalCount(c) === 1);

    await runDirectTool(c.core.deps, c.user, 'journal_open', {}, { timezone: TZ, command: '/journal' });
    r = await c.turn('Kids made pancakes this morning. Fixed the inverter in the afternoon. Feeling heavy though.');
    c.check('session dump saved', journalCount(c) >= 2);
    r = await c.turn("that's it");
    c.check('session closed', !c.store.getState(c.user).journalOpen);
    r = await c.turn('fine.');
    c.check('"fine." gets presence, not a lecture', r.reply.length < 600 && !/depress|diagnos|therap/i.test(r.reply), `${r.reply.length} chars`);

    const photo = path.join(__dirname, '../fixtures/handwritten-note.jpg');
    {
      r = await c.turn({ kind: 'message', media: [{ kind: 'photo', localPath: photo, mime: 'image/jpeg' }] });
      c.check('photo described truthfully', any(r.reply, 'garden', 'tomato', 'compost', 'hose', 'seedling'), r.reply.slice(0, 120));
      const n = journalCount(c);
      const notes = c.store.listNotebooks(c.user).length;
      r = await c.turn('keep it');
      const latest = c.store.getDay(c.user, c.today());
      const asEntry = journalCount(c) === n + 1 && Boolean(latest?.entries.at(-1)?.media.length);
      const asNote = c.store.listNotebooks(c.user).length > notes && (c.store.searchNotes(c.user, 'tomatoes').length > 0 || c.store.searchNotes(c.user, 'garden').length > 0);
      c.check('keep it saves the photo (journal with image, or note with its text)', asEntry || asNote, `entry=${asEntry} note=${asNote}`);
    }

    const fresh = makeCtx('soak-empty', 0);
    await runDirectTool(fresh.core.deps, fresh.user, 'journal_open', {}, { timezone: TZ, command: '/journal' });
    r = await fresh.turn("that's it");
    c.check('empty wrap invents nothing', fresh.store.listDays(fresh.user).length === 0 && !fresh.store.getState(fresh.user).journalOpen);

    r = await c.turn('what do my notes say about money?');
    const realPaths = new Set(c.store.listNotebooks(c.user).flatMap((n) => c.store.searchNotes(c.user, n.notebook, 50).map((h) => h.path)));
    const invented = uncitedPaths(r.reply, realPaths, c.store.listNotebooks(c.user).map((n) => n.notebook));
    c.check('notes miss is honest (no invented citation)', invented.length === 0, invented.join(', ') || r.reply.slice(0, 160));

    r = await c.turn('¡Hola! Estoy agotada hoy, hubo mucho trabajo.');
    c.check('other languages handled', r.reply.length > 0 && !r.degraded);
  },

  async web(c) {
    const r = await c.turn('who won the 2026 FIFA World Cup final, and what was the score?');
    c.check('uses web search for a current fact', r.trace.some((t) => t.tool === 'web_search' && t.ok), r.trace.map((t) => t.tool).join(','));
    c.check('answers with a team and a score', /\b(spain|argentina|france|brazil|england|germany|portugal)\b/i.test(r.reply) && /\d\s*[–-]\s*\d/.test(r.reply), r.reply.slice(0, 200));
    c.check('nothing written from web content', journalCount(c) === 0 && c.store.listFacts(c.user).length === 0);
  },

  async tonight(c) {
    // Built from a real test session (2026-10-02).
    let r = await c.turn("You're too wordy. Reduce that. Be very casual");
    c.check('style request saved as a standing instruction', c.store.listFacts(c.user).some((f) => f.kind === 'instruction'), JSON.stringify(c.store.listFacts(c.user)));
    r = await c.turn('what is a good name for a small bakery?');
    c.check('then actually brief', r.reply.length < 450, `${r.reply.length} chars`);
    await runDirectTool(c.core.deps, c.user, 'journal_open', {}, { timezone: TZ, command: '/journal' });
    const chat = ['Hi. What is your name?', 'What do you know about me?', 'give me a fun fact', 'what day is today?', 'ok cool'];
    let nags = 0;
    for (const t of chat) {
      r = await c.turn(t);
      if (/\b(page|journal)\b[^.!?\n]*\?/i.test(r.reply)) nags++;
    }
    c.check('no nagging about the open journal (≤1 mention in 5 replies)', nags <= 1, `${nags} mentions`);
    r = await c.turn('Do you have access to my onenote? connect it');
    c.check('OneNote: offers a sign-in link instead of "can\'t"', r.trace.some((x) => x.tool === 'connect_service') && /login\.microsoftonline\.com/.test(r.reply), r.reply.slice(0, 200));
    r = await c.turn('current price of dollar to yen');
    c.check('rate from the exact source', r.trace.some((x) => x.tool === 'currency_rate' && x.ok) && /1[0-9]{2}(\.\d+)?/.test(r.reply), r.trace.map((x) => x.tool).join(',') + ' | ' + r.reply.slice(0, 120));
    r = await c.turn('google this: world news right now');
    c.check('news search for news', r.trace.some((x) => x.tool === 'web_search' && x.args.kind === 'news'), r.trace.map((x) => `${x.tool}:${JSON.stringify(x.args)}`).join(' '));
    r = await c.turn('nope. good night');
    c.check('good night closes the open journal', !c.store.getState(c.user).journalOpen);
  },

  async truth(c) {
    const replies: string[] = [];
    for (const t of ['save this to my journal: finished the new shelves at the school', 'is that in OneNote now?', 'remember that my daughter is called Mira', 'did you actually save that?']) {
      const r = await c.turn(t);
      replies.push(r.reply);
    }
    c.check('never claims OneNote', !replies.some(claimsOneNote), replies.find(claimsOneNote));
    c.check('journal entry saved', journalCount(c) === 1);
    c.check('fact saved', c.store.listFacts(c.user).some((f) => has(f.text, 'mira')));
  },
};

async function main(): Promise<void> {
  if (!providersFromEnv().length) throw new Error('No model configured (DEEPSEEK_API_KEY)');
  const names = Object.keys(scenarios).filter((n) => !ONLY || ONLY.split(',').includes(n));
  const summary: Record<string, { pass: number; total: number }> = {};
  const lines: string[] = [];
  for (const name of names) {
    for (let run = 1; run <= RUNS; run++) {
      const c = makeCtx(name, run);
      const t0 = Date.now();
      try {
        await scenarios[name](c);
      } catch (err) {
        c.check('scenario completed', false, err instanceof Error ? err.message : String(err));
      }
      for (const ch of c.checks) {
        const k = `${name} › ${ch.name}`;
        summary[k] = summary[k] || { pass: 0, total: 0 };
        summary[k].total++;
        if (ch.ok) summary[k].pass++;
      }
      const failed = c.checks.filter((x) => !x.ok).length;
      const head = `== ${name} run ${run}: ${c.checks.length - failed}/${c.checks.length} checks passed (${Math.round((Date.now() - t0) / 1000)}s)`;
      console.log(head);
      lines.push(head, ...(failed ? c.log : []), '');
      if (failed) for (const l of c.log.filter((x) => x.startsWith('   ✗'))) console.log(l);
    }
  }
  const total = Object.values(summary).reduce((a, s) => ({ pass: a.pass + s.pass, total: a.total + s.total }), { pass: 0, total: 0 });
  const table = Object.entries(summary).map(([k, s]) => `${s.pass === s.total ? '✓' : '✗'} ${s.pass}/${s.total}  ${k}`);
  const report = ['# Live evaluation', `Model: ${providersFromEnv().map((p) => p.model).join(', ')}  Runs: ${RUNS}  Date: ${new Date().toISOString()}`, '', `Overall: ${total.pass}/${total.total} checks (${Math.round((100 * total.pass) / total.total)}%)`, '', ...table, '', '## Transcripts of runs with failures', '', ...lines].join('\n');
  const out = path.join(__dirname, '../../state/live-eval-report.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, report);
  console.log('\n' + table.join('\n'));
  console.log(`\nOverall: ${total.pass}/${total.total} (${Math.round((100 * total.pass) / total.total)}%). Report: ${out}`);
  process.exitCode = total.pass === total.total ? 0 : 1;
}

void main();
