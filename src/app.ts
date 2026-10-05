/**
 * i-Journal: one Telegram DM per person, one model loop (src/core), OneNote as an optional mirror.
 * See docs/runtime.md.
 */
import fs from 'fs';
import path from 'path';
import { ALLOWED_UPDATES, createBot, registerCommandMenu } from './bot';
import { appVersion } from './bot/person/gateway';
import { createOneNoteService } from './bot/person/onenoteService';
import { attachPersonBot, createPersonRuntime } from './bot/person/runtime';
import { config, hasMicrosoftConfigured } from './config';
import { createLogger } from './core/log';
import { closeDb, getDb } from './db';
import { upsertUser } from './db/users.repo';
import { startWebServer } from './web';

const version = appVersion();
const log = createLogger({ base: { app: 'i-journal', version } });

const OWNER_COMMANDS = [
  { command: 'debug', description: 'How the app is doing (owner)' },
  { command: 'export', description: 'Download the turn log (owner)' },
];

const isPollingConflict = (error: unknown) => (error as { response?: { error_code?: number } })?.response?.error_code === 409;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One poller per bot token: a second local process would kill both with 409s. The lock holds the
 * pid; a stale lock (process gone) is taken over.
 */
function acquireLock(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        log.error(`another instance (pid ${pid}) is already running; stop it first, or delete ${file} if it is stale`);
        process.exit(1);
      } catch {
        // stale lock
      }
    }
  } catch {
    // no lock yet
  }
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };
}

async function main(): Promise<void> {
  const db = getDb();
  const bot = createBot(config.telegram.botToken, log.child('telegram'));
  const dataDir = config.dbPath ? path.dirname(config.dbPath) : path.join(__dirname, '../data');

  // Late-bound: the OneNote service needs to message people, which needs the bot wiring below.
  let notify: (userKey: string, markdown: string) => Promise<void> = async () => undefined;
  let resetSync: (userKey: string) => void = () => undefined;

  const oneNote = createOneNoteService({
    db,
    app: hasMicrosoftConfigured()
      ? { clientId: config.microsoft.clientId, clientSecret: config.microsoft.clientSecret, tenant: config.microsoft.tenantId, redirectUri: config.microsoft.redirectUri }
      : null,
    preferLink: config.microsoft.redirectExplicit,
    stateSecret: config.stateSecret,
    log: log.child('onenote'),
    notify: (userKey, markdown) => notify(userKey, markdown),
    onConnected: (userKey) => resetSync(userKey),
  });

  const runtime = createPersonRuntime(db, {
    log: log.child('core'),
    defaultTimezone: config.timezone,
    connectLink: async (userKey, service) => (service === 'onenote' ? oneNote.offer(userKey) : { error: 'I can only connect OneNote so far.' }),
    library: oneNote.library,
  });

  const person = attachPersonBot(bot, runtime, {
    mediaDir: path.join(dataDir, 'telegram-media'),
    storage: (userKey) => oneNote.storageLines(userKey),
    health: () => [`• OneNote: ${oneNote.configured ? 'available' : 'not set up on this server'}`],
    // People who set up the old version keep their access.
    knownUsers: (db.prepare('SELECT telegram_id FROM users WHERE onboarding_complete = 1').all() as Array<{ telegram_id: string }>).map((r) => r.telegram_id),
    // Keep the users table current (OneNote connections hang off it).
    onSeen: (from) => upsertUser({ telegramId: String(from.id), username: from.username, firstName: from.first_name, isOwner: String(from.id) === config.telegram.ownerId }),
  });
  notify = person.notify;
  resetSync = person.resetSync;

  const startedAt = new Date();
  const web = startWebServer({
    port: config.web.port,
    log: log.child('web'),
    webhook: config.webhook.enabled ? { bot, path: config.webhook.path, secretToken: config.webhook.secretToken } : undefined,
    oauth: oneNote.configured ? { complete: (s, c) => oneNote.completeLink(s, c), failed: (s, d) => oneNote.linkFailed(s, d) } : undefined,
    health: () => ({ version, mode: config.webhook.enabled ? 'webhook' : 'polling', models: runtime.providers(), upSince: startedAt.toISOString() }),
  });

  const releaseLock = config.webhook.enabled ? undefined : acquireLock(path.join(process.cwd(), 'state', 'bot.lock'));

  log.info('starting', {
    nodeEnv: config.nodeEnv,
    mode: config.webhook.enabled ? 'webhook' : 'polling',
    publicUrl: config.webhook.publicUrl || undefined,
    db: config.dbPath || 'data/i-journal.db',
    models: runtime.providers(),
    onenote: oneNote.configured ? { tenant: config.microsoft.tenantId, signIn: config.microsoft.redirectExplicit && config.microsoft.redirectUri.startsWith('https://') ? 'link' : 'code' } : 'not configured',
    defaultTimezone: runtime.defaultTimezone,
    owner: Boolean(config.telegram.ownerId),
  });
  if (oneNote.configured && /^[0-9a-f-]{36}$/i.test(config.microsoft.tenantId)) {
    log.warn('MICROSOFT_TENANT_ID is one organization: personal Microsoft accounts will sign in as its guests and OneNote will not work for them. Use "common" unless every user is in that organization.');
  }

  /** Once per new version: tell the owner it is live and whether it can think. */
  async function deployNotice(): Promise<void> {
    const owner = config.telegram.ownerId;
    if (!owner) return;
    const store = runtime.core.deps.store;
    const st = store.getState(owner);
    if (st.noticedVersion === version) return;
    let model = 'none configured';
    if (runtime.providers().length) {
      try {
        const r = await runtime.core.deps.model.complete({ messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 5, purpose: 'task' });
        model = `${r.provider}:${r.model} ✓`;
      } catch (err) {
        model = `${runtime.providers().join(', ')} ✖ (${(err instanceof Error ? err.message : String(err)).slice(0, 120)})`;
      }
    }
    log.info('model check', { model });
    const on = oneNote.library ? await oneNote.library.status(owner) : null;
    const oneNoteLine = !oneNote.configured ? 'not set up on this server' : on?.connected ? `connected${on.label ? ` (${on.label})` : ''}` : `${on?.error && on.error !== 'not connected' ? on.error : 'not connected'} — say *connect OneNote*`;
    const lines = [`🆕 *i-Journal is updated* (version ${version}).`, `• Model: ${model}`, `• OneNote: ${oneNoteLine}`];
    const mine = runtime.imported.find((r) => r.userKey === owner);
    const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    if (mine && !mine.skipped) {
      lines.push(
        `• Brought over from the old version: ${n(mine.entries, 'journal entry', 'journal entries')} over ${n(mine.days, 'day', 'days')}, ${n(mine.facts, 'thing', 'things')} about you, ${n(mine.reminders, 'reminder or routine', 'reminders and routines')}.`
      );
    }
    if (!runtime.providers().length) lines.push('', 'I need a model key to think. Send `/key DEEPSEEK_API_KEY your-key` here (I delete that message), or add it in Railway → Variables.');
    lines.push('', 'Owner tools: /debug shows how things are going, /export sends the turn log.');
    await notify(owner, lines.join('\n'));
    const fresh = store.getState(owner);
    fresh.noticedVersion = version;
    store.saveState(owner, fresh);
  }

  const afterLaunch = async () => {
    log.info('bot is running');
    void registerCommandMenu(bot, person.commands, log, config.telegram.ownerId ? { chatId: config.telegram.ownerId, extra: OWNER_COMMANDS } : undefined);
    await person.afterLaunch().catch((err) => log.error('inbox replay failed', { error: String(err) }));
    oneNote.resumePending();
    await oneNote.checkAll().catch((err) => log.warn('onenote check failed', { error: String(err) }));
    const pruned = runtime.core.deps.store.pruneLogs(new Date(Date.now() - 120 * 86_400_000).toISOString());
    if (pruned) log.info('old turn logs pruned', { rows: pruned });
    await deployNotice().catch((err) => log.warn('deploy notice failed', { error: String(err) }));
  };

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode?: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    try {
      bot.stop(signal);
    } catch {
      // not polling (webhook mode)
    }
    person.stop();
    oneNote.stop();
    releaseLock?.();
    web.close();
    closeDb();
    if (typeof exitCode === 'number') setTimeout(() => process.exit(exitCode), 250);
  };
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception; exiting for a clean restart', { error: err.stack || err.message });
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection (continuing)', { error: reason instanceof Error ? reason.stack || reason.message : String(reason) });
  });

  const dropPending = process.env.TELEGRAM_DROP_PENDING === '1';
  const allowedUpdates = [...ALLOWED_UPDATES];

  /** A 409 at launch is a deploy overlap (the previous instance is still polling): wait it out. */
  const launchPolling = async () => {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.launch({ dropPendingUpdates: dropPending, allowedUpdates }, () => void afterLaunch());
        return;
      } catch (error) {
        if (!isPollingConflict(error) || Date.now() - started > 5 * 60_000) throw error;
        const wait = Math.min(3000 * attempt, 15_000);
        log.warn('telegram polling is held by another instance; waiting', { waitMs: wait, attempt });
        await sleep(wait);
      }
    }
  };

  if (config.webhook.enabled) {
    const url = `${config.webhook.publicUrl}${config.webhook.path}`;
    try {
      await bot.telegram.setWebhook(url, { secret_token: config.webhook.secretToken, drop_pending_updates: dropPending, allowed_updates: allowedUpdates });
      bot.botInfo ??= await bot.telegram.getMe();
      log.info('webhook mode', { url });
      await afterLaunch();
    } catch (error) {
      log.error('setWebhook failed; falling back to polling', { error: error instanceof Error ? error.message : String(error) });
      await bot.telegram.deleteWebhook({ drop_pending_updates: dropPending }).catch(() => undefined);
      await launchPolling();
    }
  } else {
    await bot.telegram.deleteWebhook({ drop_pending_updates: dropPending }).catch(() => undefined);
    await launchPolling();
  }
}

main().catch((error) => {
  log.error(isPollingConflict(error) ? 'telegram polling stayed locked by another instance' : 'fatal error', {
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
  closeDb();
  process.exit(1);
});
