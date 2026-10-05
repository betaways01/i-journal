import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Context, Telegraf } from 'telegraf';
import { Core, createCore, createModelClient, providersFromEnv, SqliteStore } from '../../core';
import { importLegacyDb, LegacyDbReport } from '../../core/importLegacyDb';
import { createLogger } from '../../core/log';
import { isValidTimezone } from '../../core/time';
import { createSweeper } from '../../core/sweeper';
import { createDataPort } from '../../core/ports/data';
import { createSense, senseFromKeys } from '../../core/ports/sense';
import { createWebPort } from '../../core/ports/web';
import { Logger, Ports } from '../../core/types';
import { enqueueUserTurn } from '../queue';
import { allowListFromEnv, GatewayDeps, PERSON_COMMANDS, registerPersonBot } from './gateway';
import { Inbox } from './inbox';
import { deliverMarkdown } from './telegramIo';

/** Readable console logger for scripts and tests. The app uses createLogger from core/log. */
export function consoleLogger(prefix = 'person'): Logger {
  return createLogger({ json: false, scope: prefix });
}

/** Keys the model client can use, in priority order. */
export const MODEL_KEYS = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'] as const;

export interface PersonRuntime {
  core: Core;
  store: SqliteStore;
  log: Logger;
  /** provider:model, in fallback order. */
  providers(): string[];
  inbox: Inbox;
  /** Timezone for people who haven't said theirs (deployment setting). */
  defaultTimezone: string;
  /** Rebuilds what depends on keys (model, web search, voice). Keys: .env first, then the owner's /key vault. */
  refreshPorts(): void;
  /** What was brought over from the original companion's tables on this start (empty after the first time). */
  imported: LegacyDbReport[];
}

export function createPersonRuntime(
  db: Database.Database,
  opts: { env?: NodeJS.ProcessEnv; log?: Logger; connectLink?: Ports['connectLink']; library?: Ports['library']; defaultTimezone?: string } = {}
): PersonRuntime {
  const env = opts.env ?? process.env;
  const log = opts.log ?? consoleLogger();
  const tzWanted = (opts.defaultTimezone || env.TIMEZONE || '').trim();
  const defaultTimezone = tzWanted && isValidTimezone(tzWanted) ? tzWanted : 'UTC';
  if (tzWanted && defaultTimezone !== tzWanted) log.error(`TIMEZONE "${tzWanted}" is not a valid IANA timezone; using UTC.`);
  const secretKey = (env.PERSON_SECRET_KEY || '').trim() || crypto.createHash('sha256').update('i-journal-secrets:' + (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN_TEST || '')).digest('hex');
  const store = new SqliteStore(db, { secretKey });
  const owner = (env.TELEGRAM_OWNER_ID || '').trim();
  const keyOf = (name: string) => (env[name] || '').trim() || (owner ? store.getSecret(owner, name)?.value || '' : '');

  const modelEnv = () => ({ ...env, ...Object.fromEntries(MODEL_KEYS.map((k) => [k, keyOf(k)])) });
  let providers = providersFromEnv(modelEnv());
  const ports: Ports = { data: createDataPort({ log }), connectLink: opts.connectLink, library: opts.library };
  const cap = Number(env.PERSON_DAILY_TOKEN_CAP);
  const core = createCore({
    store,
    model: createModelClient({ providers, log }),
    ports,
    log,
    config: {
      defaultTimezone,
      ...(Number.isFinite(cap) && cap >= 0 && env.PERSON_DAILY_TOKEN_CAP ? { dailyTokenCap: cap } : {}),
    },
  });

  const refreshPorts = () => {
    const next = providersFromEnv(modelEnv());
    const changed = next.map((p) => p.name + p.apiKey).join() !== providers.map((p) => p.name + p.apiKey).join();
    if (changed) {
      providers = next;
      (core.deps as { model: unknown }).model = createModelClient({ providers, log });
      log.info('model providers updated', { providers: providers.map((p) => `${p.name}:${p.model}`) });
    }
    ports.web = createWebPort({ env: { ...env, BRAVE_API_KEY: keyOf('BRAVE_API_KEY'), TAVILY_API_KEY: keyOf('TAVILY_API_KEY') }, log });
    const sense = senseFromKeys({ groq: keyOf('GROQ_API_KEY'), openai: keyOf('OPENAI_API_KEY') });
    ports.sense = sense ? createSense(sense, { log }) : undefined;
  };
  refreshPorts();
  if (!providers.length) log.error('No model provider configured. Set DEEPSEEK_API_KEY (Railway variables or .env), or the owner sends /key DEEPSEEK_API_KEY <key> in Telegram.');

  let imported: LegacyDbReport[] = [];
  try {
    imported = importLegacyDb(db, store, { log, defaultTimezone });
  } catch (err) {
    log.error('legacy import failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return {
    core,
    store,
    log,
    providers: () => providers.map((p) => `${p.name}:${p.model}`),
    inbox: new Inbox(db),
    defaultTimezone,
    refreshPorts,
    imported,
  };
}

export interface AttachOptions {
  mediaDir: string;
  defaultTimezone?: string;
  storage?: (userKey: string) => Promise<string[]>;
  /** Extra lines for /health. */
  health?: () => string[];
  env?: NodeJS.ProcessEnv;
  sweepMs?: number;
  stream?: boolean;
  onSeen?: GatewayDeps['onSeen'];
  /** Telegram ids that already used this bot (kept on the allowlist). */
  knownUsers?: string[];
}

/** Wires the person harness into a telegraf bot and starts the sweeper. */
export function attachPersonBot(
  bot: Telegraf,
  runtime: PersonRuntime,
  opts: AttachOptions
): { stop(): void; afterLaunch(): Promise<void>; commands: typeof PERSON_COMMANDS; notify(userKey: string, markdown: string): Promise<void>; resetSync(userKey: string): void } {
  const { core, log } = runtime;
  const defaultTimezone = opts.defaultTimezone || runtime.defaultTimezone;
  const startedAt = new Date();
  const env = opts.env ?? process.env;
  const owner = (env.TELEGRAM_OWNER_ID || '').trim();
  const deps: GatewayDeps = {
    core,
    enqueue: (userKey, job) => enqueueUserTurn(userKey, job),
    mediaDir: opts.mediaDir,
    defaultTimezone,
    allow: allowListFromEnv(env, log, opts.knownUsers),
    log,
    inbox: runtime.inbox,
    stream: opts.stream ?? env.PERSON_STREAM !== '0',
    onKeysChanged: () => runtime.refreshPorts(),
    storage: opts.storage,
    isOwner: (userKey) => Boolean(owner) && userKey === owner,
    onSeen: opts.onSeen,
    modelReady: () => runtime.providers().length > 0,
    health: () => [
      `• Model: ${runtime.providers().join(' → ') || 'none — add DEEPSEEK_API_KEY'}`,
      `• Web search: ${env.BRAVE_API_KEY || env.TAVILY_API_KEY ? 'with an API key' : 'keyless (Brave page, Wikipedia, news)'}`,
      `• Up since: ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      ...(opts.health ? opts.health() : []),
    ],
  };
  const person = registerPersonBot(bot, deps);
  const deliver = async (userKey: string, markdown: string) => {
    await deliverMarkdown(bot.telegram as never, Number(userKey), markdown, { log });
  };
  const sweeper = createSweeper({
    core,
    defaultTimezone,
    log,
    tidy: true,
    sync: true,
    canDeliver: (userKey) => /^\d+$/.test(userKey) && deps.allow.isAllowed(userKey),
    enqueue: (userKey, job) => enqueueUserTurn(userKey, job),
    // DeliveryError carries `permanent`, which the sweeper reads to cancel instead of retrying.
    deliver,
  });
  sweeper.start(opts.sweepMs ?? 15_000);
  return {
    commands: PERSON_COMMANDS,
    afterLaunch: async () => {
      const n = await person.replayInbox(bot.telegram as never);
      if (n) log.info('replayed unfinished messages from before the restart', { count: n });
    },
    /** A message from the app (not a reply), kept in the conversation so the companion knows it was said. */
    notify: (userKey, markdown) =>
      enqueueUserTurn(userKey, async () => {
        await deliver(userKey, markdown);
        core.deps.store.appendMessages(userKey, [{ role: 'assistant', content: markdown, at: new Date().toISOString(), origin: 'notice' }]);
      }),
    resetSync: (userKey) => sweeper.resetSync(userKey),
    stop: () => {
      sweeper.stop();
      person.albums.flushAll();
    },
  };
}

export type { Context };
