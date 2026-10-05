/**
 * Telegram gateway for the person harness (PERSON_AGENT=1). Handlers capture the update, write it
 * to the durable inbox, queue the turn per user, and return at once so polling never stalls.
 */
import path from 'path';
import { Context, Telegraf } from 'telegraf';
import { Core, describeReminder, renderDay } from '../../core';
import { resetConversation, resolveApproval, runDirectTool } from '../../core/commands';
import { formatLocal, localParts, weekdayOf } from '../../core/time';
import { exportJsonl, reactionScore, summarize } from '../../core/insights';
import { Inbound, Logger, PendingApproval } from '../../core/types';
import { Inbox } from './inbox';
import { AlbumCollector, downloadMedia, TgMessage, toInbound } from './inbound';
import { DeliveryError, deliverMarkdown, keepTyping, react, ReactApi, reactionFor, ReplyStream, StreamApi, TelegramApi } from './telegramIo';

export interface AllowList {
  isAllowed(userId: number | string): boolean;
  describe(): string;
}

/** Owner + TELEGRAM_ALLOWED_IDS + `known` (people who already used this bot, e.g. in the old version). */
export function allowListFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Logger, known: string[] = []): AllowList {
  const ids = new Set(
    [env.TELEGRAM_OWNER_ID || '', ...(env.TELEGRAM_ALLOWED_IDS || '').split(/[\s,]+/), ...known].map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
  );
  if (known.length) log?.info('allowing people who already used this bot', { count: known.length });
  const production = env.NODE_ENV === 'production';
  if (!ids.size) {
    if (production) log?.error('No TELEGRAM_OWNER_ID / TELEGRAM_ALLOWED_IDS set in production: refusing everyone.');
    else log?.warn('No TELEGRAM_OWNER_ID / TELEGRAM_ALLOWED_IDS set: development mode allows everyone.');
  }
  return {
    isAllowed: (userId) => (ids.size ? ids.has(String(userId)) : !production),
    describe: () => (ids.size ? `${ids.size} allowed user(s)` : production ? 'nobody (not configured)' : 'everyone (dev)'),
  };
}

export const PERSON_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'journal', description: "Open today's journal" },
  { command: 'thats_it', description: 'Close the journal for today' },
  { command: 'last', description: 'Show your latest journal page' },
  { command: 'reminders', description: 'Your pending reminders and routines' },
  { command: 'memory', description: 'What I remember about you' },
  { command: 'stop', description: 'Stop the reply I am writing' },
  { command: 'new', description: 'Start a fresh conversation (memory stays)' },
  { command: 'reset', description: 'Wipe chat, memory, or everything' },
  { command: 'key', description: 'Add an API key: /key NAME value' },
  { command: 'storage', description: 'Where your journal is saved' },
  { command: 'health', description: 'Check that everything is working' },
  { command: 'help', description: 'What I can do' },
];

const HELP = [
  "I'm your companion — talk to me like a friend.",
  '',
  '• Ask anything: news, rates, weather, code, study, plans. I look things up when I need to.',
  "• /journal opens today's page; tell me your day. Say *that's it* to close it.",
  '• Reminders and routines: "remind me at 6 to call mum", "every morning send me a quote".',
  '• Tell me how you like me to talk ("shorter", "more casual") and I stick to it.',
  '• Photos: I can see them. Voice notes: add a Groq key with /key GROQ_API_KEY your-key.',
  '• /memory, /reminders, /last to look; /stop to cut me off; /new for a fresh chat; /reset to wipe.',
].join('\n');

const INTERNAL_ERROR = "Something went wrong on my side while handling that — it's not you, and it's been logged. If it was something you wanted kept, send it again in a moment.";

/** Hosts a known key may be sent to without asking. */
const KEY_HOSTS: Record<string, string[]> = {
  DEEPSEEK_API_KEY: ['api.deepseek.com'],
  OPENROUTER_API_KEY: ['openrouter.ai'],
  GROQ_API_KEY: ['api.groq.com'],
  OPENAI_API_KEY: ['api.openai.com'],
  BRAVE_API_KEY: ['api.search.brave.com'],
  TAVILY_API_KEY: ['api.tavily.com'],
};

export interface GatewayDeps {
  core: Core;
  enqueue(userKey: string, job: () => Promise<void>): Promise<void>;
  mediaDir: string;
  defaultTimezone: string;
  allow: AllowList;
  log: Logger;
  inbox?: Inbox;
  /** Live-updating replies (default on). */
  stream?: boolean;
  /** Called after /key changes a key, so ports can pick it up. */
  onKeysChanged?: (userKey: string) => void;
  /** Lines for /storage. */
  storage?: (userKey: string) => Promise<string[]>;
  /** Extra lines for /health. */
  health?: () => string[];
  /** The deployment owner (sees /debug and /export, and setup hints). */
  isOwner?: (userKey: string) => boolean;
  /** False while no model provider is configured. */
  modelReady?: () => boolean;
  /** Called for every allowed update with who sent it (keeps the users table current). */
  onSeen?: (from: { id: number; username?: string; first_name?: string }) => void;
  now?: () => Date;
  albumWaitMs?: number;
  typingIntervalMs?: number;
  streamIntervalMs?: number;
}

type Api = TelegramApi & StreamApi & ReactApi & Parameters<typeof downloadMedia>[0];

interface AlbumMeta {
  api: Api;
  chatId: number;
  userKey: string;
  updateIds: number[];
}

export interface PersonBot {
  albums: AlbumCollector;
  /** Re-runs messages a crash interrupted. Call once after launch. */
  replayInbox(api: Api): Promise<number>;
}

const firstLine = (s: string | undefined) => (s || '').split('\n')[0].slice(0, 300);

/** Short commit id on Railway, otherwise 'dev'. */
export function appVersion(env: NodeJS.ProcessEnv = globalThis.process.env): string {
  return (env.RAILWAY_GIT_COMMIT_SHA || env.SOURCE_VERSION || '').slice(0, 7) || 'dev';
}

export function registerPersonBot(bot: Telegraf, deps: GatewayDeps): PersonBot {
  const { core, log } = deps;
  const store = core.deps.store;
  const now = deps.now ?? (() => new Date());
  const albumMeta = new Map<string, AlbumMeta>();
  const refused = new Set<string>();
  const active = new Map<string, AbortController>();

  const tzFor = (userKey: string) => store.getProfile(userKey).timezone || deps.defaultTimezone;

  async function send(api: TelegramApi, chatId: number, markdown: string): Promise<number[]> {
    try {
      return await deliverMarkdown(api, chatId, markdown, { log });
    } catch (err) {
      log.error('delivery failed', { chatId, permanent: err instanceof DeliveryError ? err.permanent : undefined, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  const SETUP_HINT =
    '\n\n*To switch me on:* send `/key DEEPSEEK_API_KEY your-key` here (I delete that message and keep the key encrypted), or add `DEEPSEEK_API_KEY` in Railway → Variables.';

  async function sendApproval(api: TelegramApi, chatId: number, a: PendingApproval): Promise<void> {
    try {
      await api.sendMessage(chatId, `🔐 ${a.label}`, {
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `appr:${a.id}:y` }, { text: '✖ No', callback_data: `appr:${a.id}:n` }]] },
      });
    } catch (err) {
      log.error('approval message failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function prepareSenses(api: Api, userKey: string, inbound: Inbound): Promise<void> {
    const prefix = String(inbound.messageId ?? Date.now());
    await downloadMedia(api, [...inbound.media, ...(inbound.target?.media || [])], path.join(deps.mediaDir, userKey), prefix, { log });
    const audio = inbound.media.find((m) => m.kind === 'voice' || m.kind === 'audio' || m.kind === 'video_note');
    if (!audio || inbound.transcript) return;
    const sense = core.deps.ports.sense;
    if (!sense) {
      inbound.transcriptMiss = 'voice transcription is not set up yet (they can add GROQ_API_KEY with /key)';
      return;
    }
    const text = audio.localPath ? await sense.transcribe(audio.localPath, audio.mime) : null;
    if (text) inbound.transcript = text;
    else inbound.transcriptMiss = audio.localPath ? "the audio couldn't be made out" : "the voice note couldn't be downloaded";
  }

  async function process(api: Api, chatId: number, userKey: string, inbound: Inbound, updateIds: number[] = []): Promise<void> {
    const ac = new AbortController();
    active.set(userKey, ac);
    const stopTyping = keepTyping(api, chatId, deps.typingIntervalMs);
    const stream = deps.stream !== false ? new ReplyStream(api, chatId, { log, intervalMs: deps.streamIntervalMs }) : null;
    const t0 = Date.now();
    try {
      await prepareSenses(api, userKey, inbound);
      const result = await core.runTurn(
        { userKey, inbound, now: now(), timezone: tzFor(userKey), signal: ac.signal },
        stream ? { onText: (t) => stream.onText(t), onTool: (e) => stream.onTool(e.name, e.phase) } : {}
      );
      stopTyping();
      if (result.degraded === 'not_configured' && deps.isOwner?.(userKey)) result.reply += SETUP_HINT;
      deps.inbox?.mark(updateIds, 'turn_done', result.silent ? '' : result.reply);
      let sent: number[] = [];
      if (result.silent || !result.reply.trim()) await stream?.discard();
      else if (stream) {
        try {
          sent = await stream.finish(result.reply, { log });
        } catch (err) {
          log.error('delivery failed', { chatId, permanent: err instanceof DeliveryError ? err.permanent : undefined, error: err instanceof Error ? err.message : String(err) });
        }
      } else sent = await send(api, chatId, result.reply);
      if (result.turnId && sent.length) store.attachTurnMessages(result.turnId, sent);
      for (const a of result.approvals) await sendApproval(api, chatId, a);
      const emoji = reactionFor(result.effects);
      if (emoji && inbound.messageId && inbound.kind === 'message') await react(api, chatId, inbound.messageId, emoji, log);
      deps.inbox?.mark(updateIds, 'done');
      log.info('turn', {
        userKey,
        turnId: result.turnId,
        kind: inbound.kind,
        ms: Date.now() - t0,
        rounds: result.rounds,
        tools: result.trace.map((t) => t.tool + (t.ok ? '' : '!')).join(','),
        effects: result.effects.map((e) => e.type).join(','),
        corrections: result.corrections.join(','),
        degraded: result.degraded,
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
      });
      await core.compact(userKey).catch((err) => log.warn('compaction error', { error: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      log.error('turn failed', { userKey, error: err instanceof Error ? err.stack || err.message : String(err) });
      await stream?.discard();
      await send(api, chatId, INTERNAL_ERROR);
      deps.inbox?.mark(updateIds, 'done');
    } finally {
      stopTyping();
      if (active.get(userKey) === ac) active.delete(userKey);
    }
  }

  const schedule = (api: Api, chatId: number, userKey: string, inbound: Inbound, updateIds: number[] = []) => {
    void deps.enqueue(userKey, () => process(api, chatId, userKey, inbound, updateIds)).catch((err) =>
      log.error('queue job failed', { userKey, error: err instanceof Error ? err.message : String(err) })
    );
  };

  /** Runs a command's work in the user's queue without blocking the handler. */
  const inQueue = (ctx: Context, work: (userKey: string, chatId: number) => Promise<void>) => {
    const userKey = String(ctx.from!.id);
    const chatId = ctx.chat!.id;
    void deps
      .enqueue(userKey, async () => {
        try {
          await work(userKey, chatId);
        } catch (err) {
          log.error('command failed', { userKey, error: err instanceof Error ? err.message : String(err) });
          await send(ctx.telegram, chatId, INTERNAL_ERROR);
        }
      })
      .catch(() => undefined);
  };

  const albums = new AlbumCollector((key, merged) => {
    const meta = albumMeta.get(key);
    albumMeta.delete(key);
    if (!meta) return;
    deps.inbox?.group(meta.updateIds, merged);
    schedule(meta.api, meta.chatId, meta.userKey, merged, meta.updateIds);
  }, deps.albumWaitMs ?? 800);

  // 1. Only allowed people reach anything below, and never the model otherwise.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return;
    if (deps.allow.isAllowed(from.id)) return next();
    log.warn('refused update from user not on the allowlist', { userId: from.id, username: from.username });
    if (ctx.callbackQuery) await ctx.answerCbQuery('This is a private bot.').catch(() => undefined);
    else if (ctx.chat?.type === 'private' && !refused.has(String(from.id))) {
      refused.add(String(from.id));
      await ctx.reply('Sorry — this is a private companion bot.').catch(() => undefined);
    }
  });

  // Group chats are not supported: one DM, one person.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    try {
      if (ctx.from) deps.onSeen?.(ctx.from);
    } catch (err) {
      log.warn('could not record the user', { error: err instanceof Error ? err.message : String(err) });
    }
    return next();
  });

  // 2. Commands
  bot.command('start', (ctx) => {
    schedule(ctx.telegram as unknown as Api, ctx.chat.id, String(ctx.from.id), { kind: 'message', messageId: ctx.message.message_id, text: '/start', media: [] });
  });

  bot.command('help', (ctx) =>
    inQueue(ctx, async (_u, chatId) => {
      await send(ctx.telegram, chatId, HELP);
    })
  );

  bot.command('stop', async (ctx) => {
    const ac = active.get(String(ctx.from.id));
    if (ac) ac.abort();
    else await ctx.reply('Nothing running right now.').catch(() => undefined);
  });

  bot.command('journal', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const res = await runDirectTool(core.deps, userKey, 'journal_open', {}, { now: now(), timezone: tzFor(userKey), command: '/journal' });
      const st = store.getState(userKey);
      const date = st.journalDate || localParts(now(), tzFor(userKey)).date;
      const day = store.getDay(userKey, date);
      const label = `${weekdayOf(date)} ${date}`;
      const lead = /already open/.test(res.content) ? `📖 The journal is already open for ${label}.` : `📖 Journal's open for ${label}.`;
      const body = day?.entries.length ? ` ${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'} on the page so far.` : '';
      await send(ctx.telegram, chatId, `${lead}${body} Tell me about your day — say *that's it* when you're done.`);
    })
  );

  bot.command('thats_it', (ctx) => {
    const userKey = String(ctx.from.id);
    const chatId = ctx.chat.id;
    const api = ctx.telegram as unknown as Api;
    void deps
      .enqueue(userKey, async () => {
        if (!store.getState(userKey).journalOpen) {
          await send(api, chatId, "The journal isn't open right now. Use /journal to start today's page.");
          return;
        }
        await process(api, chatId, userKey, { kind: 'message', messageId: ctx.message.message_id, text: "that's it — please close today's journal", media: [] });
        if (store.getState(userKey).journalOpen) {
          // The command has a required outcome: close even if the model did not.
          const res = await runDirectTool(core.deps, userKey, 'journal_close', {}, { now: now(), timezone: tzFor(userKey), command: '/thats_it' });
          await send(api, chatId, firstLine(res.content));
        }
      })
      .catch(() => undefined);
  });

  bot.command('new', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      resetConversation(core.deps, userKey);
      await send(ctx.telegram, chatId, "Fresh conversation. I still remember what you've told me, and your journal and reminders are untouched.");
    })
  );

  bot.command('reset', (ctx) =>
    inQueue(ctx, async (_userKey, chatId) => {
      await ctx.telegram.sendMessage(chatId, 'What should I wipe?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Chat history', callback_data: 'reset:chat' }],
            [{ text: 'Chat + memory (keep journal)', callback_data: 'reset:memory' }],
            [{ text: 'Everything', callback_data: 'reset:all' }],
            [{ text: 'Cancel', callback_data: 'reset:cancel' }],
          ],
        },
      });
    })
  );

  bot.command('key', async (ctx) => {
    const userKey = String(ctx.from.id);
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const name = (parts[1] || '').toUpperCase();
    const value = parts.slice(2).join(' ');
    if (value) await ctx.deleteMessage().catch(() => undefined);
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
      await ctx.reply('Send it like this: /key GROQ_API_KEY your-key\nTo remove one: /key GROQ_API_KEY').catch(() => undefined);
      return;
    }
    if (!value) {
      const removed = store.removeSecret(userKey, name);
      deps.onKeysChanged?.(userKey);
      await ctx.reply(removed ? `Removed ${name}.` : `There's no key called ${name}.`).catch(() => undefined);
      return;
    }
    store.setSecret(userKey, name, value, KEY_HOSTS[name] || [], now());
    deps.onKeysChanged?.(userKey);
    log.info('key saved', { userKey, name });
    const modelKey = name === 'DEEPSEEK_API_KEY' || name === 'OPENROUTER_API_KEY';
    const what = modelKey
      ? deps.isOwner?.(userKey)
        ? deps.modelReady?.()
          ? ' The model is on — talk to me.'
          : ' (It did not switch the model on — check the key.)'
        : ' Only the owner’s model key is used, so this one is kept but not used.'
      : name === 'GROQ_API_KEY' || name === 'OPENAI_API_KEY'
        ? ' Voice notes are on.'
        : name === 'BRAVE_API_KEY' || name === 'TAVILY_API_KEY'
          ? ' Web search will use it.'
          : '';
    await ctx.reply(`🔑 Saved ${name}. I deleted your message so the key isn't left in the chat — I never see its value.${what}`).catch(() => undefined);
  });

  bot.command('keys', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const keys = store.listSecrets(userKey);
      await send(ctx.telegram, chatId, keys.length ? '🔑 *Your keys*\n' + keys.map((k) => `• ${k.name}`).join('\n') + '\n\nRemove one with /key NAME' : 'No keys stored. Add one with /key NAME value.');
    })
  );

  bot.command('reminders', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const list = store.listReminders(userKey);
      const tz = tzFor(userKey);
      const text = list.length
        ? '⏰ *Pending reminders*\n' + list.map((r) => '• ' + describeReminder(r, tz, now())).join('\n') + '\n\nTell me to cancel one by its number.'
        : 'No reminders pending. Just tell me what to remind you about and when.';
      await send(ctx.telegram, chatId, text);
    })
  );

  bot.command('memory', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const p = store.getProfile(userKey);
      const facts = store.listFacts(userKey);
      const lines = ['🧠 *What I remember*', `• Your name: ${p.name || "(you haven't told me)"}`];
      if (p.agentName) lines.push(`• You call me: ${p.agentName}`);
      lines.push(`• Timezone: ${p.timezone || deps.defaultTimezone}`);
      const kept = facts.filter((f) => f.kind === 'fact');
      const rules = facts.filter((f) => f.kind === 'instruction');
      if (rules.length) lines.push('', '*How you want me to be*', ...rules.map((f) => `#${f.id} ${f.text}`));
      if (kept.length) lines.push('', '*Things you told me*', ...kept.map((f) => `#${f.id} ${f.text}`));
      if (!facts.length) lines.push('', 'Nothing else yet — I learn as we talk.');
      else lines.push('', 'Tell me to forget anything by its number.');
      await send(ctx.telegram, chatId, lines.join('\n'));
    })
  );

  bot.command('last', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const latest = store.listDays(userKey, { limit: 1 })[0];
      const day = latest ? store.getDay(userKey, latest.date) : null;
      await send(ctx.telegram, chatId, day ? renderDay(day).replace(/^# /, '## ') : 'Nothing in your journal yet. Use /journal to start a page.');
    })
  );

  bot.command('storage', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const lines = deps.storage ? await deps.storage(userKey) : ['• Your journal, notes, memory and reminders are saved in my database first, always.'];
      await send(ctx.telegram, chatId, ['💾 *Storage*', ...lines].join('\n'));
    })
  );

  // Owner-only: how the app is doing, from the turn log.
  bot.command('debug', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      if (!deps.isOwner?.(userKey)) {
        await send(ctx.telegram, chatId, 'That command is for the owner of this bot.');
        return;
      }
      const hours = Math.min(24 * 30, Math.max(1, Number((ctx.message.text || '').split(/\s+/)[1]) || 24));
      const since = new Date(now().getTime() - hours * 3_600_000);
      const text = summarize(store.turnsSince(since.toISOString()), store.issuesSince(since.toISOString()), { since, viewer: userKey, scope: `last ${hours}h` });
      await send(ctx.telegram, chatId, text + '\n\nMore: `/debug 72` for 3 days, `/export 7` for a file with a week of turns.');
    })
  );

  bot.command('export', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      if (!deps.isOwner?.(userKey)) {
        await send(ctx.telegram, chatId, 'That command is for the owner of this bot.');
        return;
      }
      const days = Math.min(90, Math.max(1, Number((ctx.message.text || '').split(/\s+/)[1]) || 7));
      const since = new Date(now().getTime() - days * 86_400_000);
      const body = exportJsonl(store, since, userKey);
      const name = `i-journal-turns-${now().toISOString().slice(0, 10)}-${days}d.jsonl`;
      await ctx.telegram.sendDocument(chatId, { source: Buffer.from(body, 'utf8'), filename: name }, { caption: `Turn log, last ${days} day(s). Your own conversation is included; other people appear only as pseudonymous numbers.` });
      log.info('turn log exported', { userKey, days, bytes: body.length });
    })
  );

  bot.command('health', (ctx) =>
    inQueue(ctx, async (userKey, chatId) => {
      const pending = store.listReminders(userKey).length;
      const today = localParts(now(), tzFor(userKey)).date;
      const u = store.getState(userKey).usage?.[today];
      const lines = [
        '❤️ *Health*',
        `• Version: ${appVersion()}`,
        `• Time here: ${formatLocal(now(), tzFor(userKey))} (${tzFor(userKey)})`,
        `• Pending reminders: ${pending}`,
        `• Today: ${u ? `${u.turns} replies, ${(u.prompt + u.completion).toLocaleString('en-US')} tokens` : 'no replies yet'}`,
        `• Voice notes: ${core.deps.ports.sense ? `on (${core.deps.ports.sense.name})` : 'off — add GROQ_API_KEY with /key'}`,
        `• Keys stored: ${store.listSecrets(userKey).map((k) => k.name).join(', ') || 'none'}`,
        ...(deps.health ? deps.health() : []),
      ];
      await send(ctx.telegram, chatId, lines.join('\n'));
    })
  );

  // 3. Buttons
  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data || '';
    const userKey = String(ctx.from.id);
    if (!ctx.chat) {
      await ctx.answerCbQuery().catch(() => undefined);
      return;
    }
    const chatId = ctx.chat.id;
    const appr = /^appr:([0-9a-f]+):(y|n)$/.exec(data);
    if (appr) {
      await ctx.answerCbQuery(appr[2] === 'y' ? 'Approved' : 'Declined').catch(() => undefined);
      void deps
        .enqueue(userKey, async () => {
          const r = await resolveApproval(core.deps, userKey, appr[1], appr[2] === 'y', { now: now(), timezone: tzFor(userKey) });
          const text = !r.found ? 'This approval expired.' : appr[2] === 'n' ? `✖ Declined: ${r.label}` : r.ok ? `✅ ${r.label}\n${firstLine(r.content)}` : `⚠️ ${r.label}\n${firstLine(r.content)}`;
          await ctx.editMessageText(text).catch(() => undefined);
        })
        .catch(() => undefined);
      return;
    }
    const reset = /^reset:(chat|memory|all|all!|cancel)$/.exec(data);
    if (reset) {
      await ctx.answerCbQuery().catch(() => undefined);
      void deps
        .enqueue(userKey, async () => {
          const what = reset[1];
          if (what === 'cancel') {
            await ctx.editMessageText('Nothing was wiped.').catch(() => undefined);
            return;
          }
          if (what === 'all') {
            await ctx
              .editMessageText('This deletes your journal, notes, reminders, keys and memory too. There is no undo. Sure?', {
                reply_markup: { inline_keyboard: [[{ text: 'Yes, delete everything', callback_data: 'reset:all!' }], [{ text: 'Cancel', callback_data: 'reset:cancel' }]] },
              })
              .catch(() => undefined);
            return;
          }
          const scope = what === 'all!' ? 'all' : (what as 'chat' | 'memory');
          store.wipeUser(userKey, scope);
          log.info('user wiped', { userKey, scope });
          const done = scope === 'chat' ? 'Chat history wiped. Memory and journal kept.' : scope === 'memory' ? 'Chat and memory wiped. Your journal is kept.' : 'Everything wiped. Fresh start.';
          await ctx.editMessageText(done).catch(() => undefined);
        })
        .catch(() => undefined);
      return;
    }
    await ctx.answerCbQuery().catch(() => undefined);
    const label = data === 'person_look' ? 'Look' : data === 'person_save' ? 'Save' : '';
    if (label) schedule(ctx.telegram as unknown as Api, chatId, userKey, { kind: 'button', text: label, media: [] });
  });

  // 4. Messages
  bot.on('message', (ctx) => {
    const msg = ctx.message as unknown as TgMessage;
    const inbound = toInbound(msg, ctx.botInfo?.id);
    if (!inbound) return;
    const userKey = String(ctx.from.id);
    const chatId = ctx.chat.id;
    const updateId = ctx.update.update_id;
    if (deps.inbox && !deps.inbox.record(updateId, userKey, chatId, inbound)) return;
    const api = ctx.telegram as unknown as Api;
    if (msg.media_group_id) {
      const key = `${userKey}:${msg.media_group_id}`;
      const meta = albumMeta.get(key) || { api, chatId, userKey, updateIds: [] };
      meta.updateIds.push(updateId);
      albumMeta.set(key, meta);
      albums.add(key, inbound);
      return;
    }
    schedule(api, chatId, userKey, inbound, [updateId]);
  });

  bot.on('edited_message', () => undefined);

  // 5. Reactions on the bot's replies: feedback for the turn log, and shown to the companion next turn.
  bot.on('message_reaction', (ctx) => {
    const r = (ctx.update as { message_reaction?: { chat: { id: number }; message_id: number; user?: { id: number }; new_reaction: Array<{ type: string; emoji?: string }> } })
      .message_reaction;
    if (!r?.user) return;
    const userKey = String(r.user.id);
    const emoji = r.new_reaction.find((x) => x.type === 'emoji')?.emoji || '';
    void deps
      .enqueue(userKey, async () => {
        const turn = store.turnForMessage(userKey, r.message_id);
        const score = reactionScore(emoji);
        if (turn) store.setTurnFeedback(turn.id, emoji, score, now());
        if (emoji && turn) {
          // The reply that turn wrote carries the turn's timestamp.
          const reply = store.messagesSince(userKey, turn.at, 40).find((m) => m.role === 'assistant' && m.at === turn.at && m.content.trim())?.content;
          const st = store.getState(userKey);
          st.feedback = [...(st.feedback || []), { emoji, score, at: now().toISOString(), excerpt: reply?.slice(0, 160) }].slice(-5);
          store.saveState(userKey, st);
        }
        log.info('reaction', { userKey, turnId: turn?.id, emoji: emoji || '(removed)', score });
      })
      .catch(() => undefined);
  });

  return {
    albums,
    async replayInbox(api: Api): Promise<number> {
      if (!deps.inbox) return 0;
      const rows = deps.inbox.unfinished();
      for (const row of rows) {
        if (!deps.allow.isAllowed(row.userKey)) {
          deps.inbox.mark(row.updateIds, 'done');
          continue;
        }
        if (row.state === 'turn_done') {
          // The turn finished but its reply may not have gone out: send that reply again.
          void deps.enqueue(row.userKey, async () => {
            if (row.reply && row.reply.trim()) await send(api, row.chatId, row.reply);
            deps.inbox!.mark(row.updateIds, 'done');
          });
          continue;
        }
        log.info('replaying a message interrupted by a restart', { userKey: row.userKey, receivedAt: row.receivedAt });
        schedule(api, row.chatId, row.userKey, row.inbound, row.updateIds);
      }
      deps.inbox.prune();
      return rows.length;
    },
  };
}
