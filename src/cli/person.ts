/**
 * Talk to the person harness in a terminal. Same loop, tools and sweeper as Telegram; its own store
 * file (state/person-cli.db) so it never touches Telegram users' data.
 *
 *   npm run person:live
 */
import 'dotenv/config';
import path from 'path';
import readline from 'readline';
import { createCore, createModelClient, describeReminder, providersFromEnv, renderDay, openCoreDb, SqliteStore } from '../core';
import { resetConversation, resolveApproval, runDirectTool } from '../core/commands';
import { createDataPort } from '../core/ports/data';
import { createSweeper } from '../core/sweeper';
import { createWebPort } from '../core/ports/web';
import { Logger } from '../core/types';

const USER = 'cli';
const TZ = process.env.TIMEZONE || 'UTC';

const quietLog: Logger = {
  info: () => undefined,
  warn: (m, d) => process.env.PERSON_DEBUG && console.warn(`  [warn] ${m} ${d ? JSON.stringify(d) : ''}`),
  error: (m, d) => console.error(`  [error] ${m} ${d ? JSON.stringify(d) : ''}`),
};

async function main(): Promise<void> {
  const file = process.env.PERSON_CLI_DB || path.join(process.cwd(), 'state', 'person-cli.db');
  const store = new SqliteStore(openCoreDb(file));
  const providers = providersFromEnv();
  if (!providers.length) console.log('(no model configured — set DEEPSEEK_API_KEY in .env)');
  const core = createCore({
    store,
    model: createModelClient({ providers, log: quietLog }),
    ports: { web: createWebPort({ log: quietLog }), data: createDataPort({ log: quietLog }) },
    log: quietLog,
    config: { defaultTimezone: TZ },
  });

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (_u: string, job: () => Promise<void>) => {
    const next = chain.then(job);
    chain = next.catch(() => undefined);
    return next;
  };
  const sweeper = createSweeper({
    core,
    defaultTimezone: TZ,
    log: quietLog,
    canDeliver: (u) => u === USER,
    enqueue,
    deliver: async (_u, md) => {
      process.stdout.write(`\n${md}\n> `);
    },
  });
  sweeper.start(10_000);

  console.log(`i-Journal person harness — ${providers.map((p) => p.model).join(', ') || 'no model'} — store ${file}`);
  console.log('Commands: /journal /thats_it /memory /reminders /last /new /approve <id> /deny <id> /quit\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/quit' || text === '/exit') {
      sweeper.stop();
      rl.close();
      return;
    }
    void enqueue(USER, async () => {
      if (text === '/new') {
        resetConversation(core.deps, USER);
        console.log('(conversation cleared; memory and journal kept)');
      } else if (text === '/journal') {
        console.log((await runDirectTool(core.deps, USER, 'journal_open', {}, { timezone: TZ, command: '/journal' })).content.split('\n')[0]);
      } else if (text === '/memory') {
        const p = store.getProfile(USER);
        console.log(`name: ${p.name || '-'}  agent: ${p.agentName || '-'}  tz: ${p.timezone || TZ}`);
        for (const f of store.listFacts(USER)) console.log(`#${f.id} [${f.kind}] ${f.text}`);
      } else if (text === '/reminders') {
        const list = store.listReminders(USER);
        console.log(list.length ? list.map((r) => describeReminder(r, TZ, new Date())).join('\n') : '(none)');
      } else if (/^\/(approve|deny) [0-9a-f]+$/.test(text)) {
        const [cmd, id] = text.slice(1).split(' ');
        const r = await resolveApproval(core.deps, USER, id, cmd === 'approve', { timezone: TZ });
        console.log(!r.found ? '(no such approval, or it expired)' : `${cmd === 'approve' ? '✅' : '✖'} ${r.label}${r.content ? ' — ' + r.content.split('\n')[0] : ''}`);
      } else if (text === '/last') {
        const d = store.listDays(USER, { limit: 1 })[0];
        console.log(d ? renderDay(store.getDay(USER, d.date)!) : '(no pages yet)');
      } else {
        const inbound = { kind: 'message' as const, text: text === '/thats_it' ? "that's it — please close today's journal" : text, media: [] };
        const res = await core.runTurn({ userKey: USER, inbound, timezone: TZ });
        process.stdout.write(res.reply);
        for (const a of res.approvals) process.stdout.write(`\n  🔐 ${a.label} — /approve ${a.id} or /deny ${a.id}`);
        const meta = [res.trace.map((t) => t.tool + (t.ok ? '' : '!')).join(','), res.corrections.length ? 'corrections=' + res.corrections.join(',') : '', res.degraded ? 'DEGRADED=' + res.degraded : '']
          .filter(Boolean)
          .join(' ');
        console.log(meta ? `\n  [${meta}]` : '');
        await core.compact(USER).catch(() => undefined);
      }
    }).finally(() => rl.prompt());
  });
  rl.on('close', () => process.exit(0));
}

void main();
