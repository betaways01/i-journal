/** Outbound Telegram plumbing: render, chunk, send with fallbacks; typing keep-alive. */
import { Logger } from '../../core/types';
import { renderReply } from '../render';

/** The subset of telegraf's Telegram client this module uses (easy to fake). */
export interface TelegramApi {
  sendMessage(chatId: number | string, text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }>;
  sendChatAction(chatId: number | string, action: 'typing'): Promise<unknown>;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** True when retrying cannot help (blocked, chat gone). */
    readonly permanent: boolean
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

interface TgErr {
  code?: number;
  description: string;
  retryAfter?: number;
}

export function telegramErrorOf(err: unknown): TgErr {
  const e = err as { response?: { error_code?: number; description?: string; parameters?: { retry_after?: number } }; message?: string };
  return {
    code: e?.response?.error_code,
    description: e?.response?.description || e?.message || String(err),
    retryAfter: e?.response?.parameters?.retry_after,
  };
}

function isPermanent(e: TgErr): boolean {
  return e.code === 403 || /chat not found|bot was blocked|user is deactivated|bot was kicked/i.test(e.description);
}

export interface DeliverOptions {
  replyTo?: number;
  replyMarkup?: Record<string, unknown>;
  disableNotification?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sendOne(api: TelegramApi, chatId: number | string, html: string, plain: string, extra: Record<string, unknown>, opts: DeliverOptions): Promise<number> {
  const sleep = opts.sleep ?? defaultSleep;
  let useHtml = true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const sent = useHtml
        ? await api.sendMessage(chatId, html, { ...extra, parse_mode: 'HTML' })
        : await api.sendMessage(chatId, plain, extra);
      return sent.message_id;
    } catch (err) {
      const e = telegramErrorOf(err);
      if (isPermanent(e)) throw new DeliveryError(e.description, true);
      if (e.code === 400 && useHtml && /can't parse entities|unsupported start tag|can't find end tag|unexpected end tag/i.test(e.description)) {
        opts.log?.warn('telegram rejected HTML; resending as plain text', { error: e.description });
        useHtml = false;
        attempt--;
        continue;
      }
      if (e.code === 400 && /reply message not found|message to be replied not found/i.test(e.description) && 'reply_parameters' in extra) {
        delete extra.reply_parameters;
        attempt--;
        continue;
      }
      if (e.code === 400) throw new DeliveryError(e.description, true);
      if (attempt === 4) throw new DeliveryError(e.description, false);
      const wait = e.code === 429 ? Math.min(30, e.retryAfter ?? 3) * 1000 : 500 * 2 ** (attempt - 1);
      opts.log?.warn('telegram send failed; retrying', { code: e.code, error: e.description, waitMs: wait });
      await sleep(wait);
    }
  }
  throw new DeliveryError('unreachable', false);
}

/** Sends a Markdown reply as one or more messages. Returns the message ids sent. */
export async function deliverMarkdown(api: TelegramApi, chatId: number | string, markdown: string, opts: DeliverOptions = {}): Promise<number[]> {
  const { html, plain } = renderReply(markdown);
  const ids: number[] = [];
  for (let i = 0; i < html.length; i++) {
    const extra: Record<string, unknown> = { link_preview_options: { is_disabled: true } };
    if (i === 0 && opts.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (i === html.length - 1 && opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
    if (opts.disableNotification) extra.disable_notification = true;
    ids.push(await sendOne(api, chatId, html[i], plain[i], extra, opts));
  }
  return ids;
}

/**
 * Shows "typing…" until stopped. Telegram clears the indicator after ~5s or when a message lands,
 * so it is re-sent every few seconds. Failures never affect the turn.
 */
export function keepTyping(api: TelegramApi, chatId: number | string, intervalMs = 4000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let cooldownUntil = 0;
  const tick = () => {
    if (stopped) return;
    if (Date.now() >= cooldownUntil) {
      api.sendChatAction(chatId, 'typing').catch((err) => {
        const e = telegramErrorOf(err);
        if (e.code === 429) cooldownUntil = Date.now() + Math.min(60, e.retryAfter ?? 10) * 1000;
        if (isPermanent(e)) stopped = true;
      });
    }
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Live replies: a message that fills in while the model writes
// ---------------------------------------------------------------------------

export interface StreamApi extends TelegramApi {
  editMessageText(chatId: number | string, messageId: number, inlineMessageId: undefined, text: string, extra?: Record<string, unknown>): Promise<unknown>;
  deleteMessage(chatId: number | string, messageId: number): Promise<unknown>;
}

const TOOL_STATUS: Record<string, string> = {
  web_search: '🔎 Searching the web…',
  web_fetch: '📖 Reading a page…',
  currency_rate: '💱 Checking rates…',
  weather: '⛅ Checking the weather…',
  bible_verse: '📖 Finding the verse…',
  wikipedia: '📚 Looking it up…',
  journal_write: '✍️ Writing it down…',
  journal_read: '📓 Reading your journal…',
  journal_search: '📓 Searching your journal…',
  journal_open: '📓 Opening today’s page…',
  journal_close: '📓 Closing the page…',
  notes_search: '🗂 Looking through your notes…',
  notes_read: '🗂 Reading your note…',
  notes_save: '🗂 Saving the note…',
  remind_set: '⏰ Setting a reminder…',
  remind_list: '⏰ Checking your reminders…',
  chat_search: '🧠 Remembering…',
  remember: '🧠 Noting that…',
  skill_save: '🧠 Writing down how to do it…',
};

export function statusForTool(name: string): string {
  return TOOL_STATUS[name] || '…';
}

/**
 * Shows the reply as it is written: one message, edited at most every `intervalMs` with plain text,
 * then replaced by the rendered final answer. Any Telegram trouble during streaming just stops the
 * live updates; the final answer is always delivered.
 */
export class ReplyStream {
  private msgId?: number;
  private shown = '';
  private text = '';
  private status = '';
  private timer?: NodeJS.Timeout;
  private timerDue = 0;
  private lastEdit = 0;
  private busy: Promise<void> = Promise.resolve();
  private live = true;

  constructor(
    private readonly api: StreamApi,
    private readonly chatId: number,
    private readonly opts: { intervalMs?: number; firstDelayMs?: number; log?: Logger } = {}
  ) {}

  onText(full: string): void {
    this.text = full;
    if (full) this.status = '';
    this.schedule();
  }

  onTool(name: string, phase: 'start' | 'end'): void {
    if (phase === 'start') {
      this.status = statusForTool(name);
      this.schedule();
    }
  }

  get messageId(): number | undefined {
    return this.msgId;
  }

  private schedule(): void {
    if (!this.live || (!this.text && !this.status)) return;
    const interval = this.opts.intervalMs ?? 1200;
    // A tool status shows at once; text waits a beat so a quick answer arrives as one message.
    const first = this.status && !this.text ? 0 : (this.opts.firstDelayMs ?? 350);
    const wait = this.msgId ? Math.max(0, interval - (Date.now() - this.lastEdit)) : first;
    const due = Date.now() + wait;
    if (this.timer) {
      if (due >= this.timerDue) return;
      clearTimeout(this.timer);
    }
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.busy = this.busy.then(() => this.push());
    }, wait);
    this.timer.unref?.();
  }

  private async push(): Promise<void> {
    if (!this.live) return;
    const body = this.text ? (this.text.length > 3900 ? this.text.slice(0, 3900) + '…' : this.text) + ' ▍' : this.status;
    if (!body || body === this.shown) return;
    try {
      if (!this.msgId) {
        const sent = await this.api.sendMessage(this.chatId, body, { link_preview_options: { is_disabled: true } });
        this.msgId = sent.message_id;
      } else {
        await this.api.editMessageText(this.chatId, this.msgId, undefined, body, { link_preview_options: { is_disabled: true } });
      }
      this.shown = body;
      this.lastEdit = Date.now();
    } catch (err) {
      const e = telegramErrorOf(err);
      if (/not modified/i.test(e.description)) return;
      if (e.code === 429) {
        this.lastEdit = Date.now() + Math.min(30, e.retryAfter ?? 3) * 1000;
        return;
      }
      this.live = false;
      this.opts.log?.warn('live reply updates stopped', { error: e.description });
    }
  }

  /** Replaces the live message with the final answer (rendered, chunked). Returns message ids. */
  async finish(markdown: string, deliverOpts: DeliverOptions = {}): Promise<number[]> {
    this.live = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.busy;
    if (!this.msgId) return deliverMarkdown(this.api, this.chatId, markdown, deliverOpts);
    const { html, plain } = renderReply(markdown);
    if (!html.length) {
      await this.api.deleteMessage(this.chatId, this.msgId).catch(() => undefined);
      return [];
    }
    const extra = { link_preview_options: { is_disabled: true } };
    try {
      await this.api.editMessageText(this.chatId, this.msgId, undefined, html[0], { ...extra, parse_mode: 'HTML' });
    } catch (err) {
      const e = telegramErrorOf(err);
      if (!/not modified/i.test(e.description)) {
        try {
          await this.api.editMessageText(this.chatId, this.msgId, undefined, plain[0], extra);
        } catch (err2) {
          if (!/not modified/i.test(telegramErrorOf(err2).description)) {
            await this.api.deleteMessage(this.chatId, this.msgId).catch(() => undefined);
            return deliverMarkdown(this.api, this.chatId, markdown, deliverOpts);
          }
        }
      }
    }
    const ids = [this.msgId];
    const rest = html.slice(1).length ? await deliverChunks(this.api, this.chatId, html.slice(1), plain.slice(1), deliverOpts) : [];
    return [...ids, ...rest];
  }

  /** Removes the live message (e.g. a silent turn). */
  async discard(): Promise<void> {
    this.live = false;
    if (this.timer) clearTimeout(this.timer);
    await this.busy;
    if (this.msgId) await this.api.deleteMessage(this.chatId, this.msgId).catch(() => undefined);
  }
}

async function deliverChunks(api: TelegramApi, chatId: number | string, html: string[], plain: string[], opts: DeliverOptions): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < html.length; i++) {
    const extra: Record<string, unknown> = { link_preview_options: { is_disabled: true } };
    if (i === html.length - 1 && opts.replyMarkup) extra.reply_markup = opts.replyMarkup;
    ids.push(await sendOne(api, chatId, html[i], plain[i], extra, opts));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export interface ReactApi {
  setMessageReaction(chatId: number | string, messageId: number, reaction?: Array<{ type: 'emoji'; emoji: string }>): Promise<unknown>;
}

/** A quiet acknowledgement on their message. Telegram only allows a fixed set of emoji. */
export function reactionFor(effects: Array<{ type: string }>): string | null {
  const t = new Set(effects.map((e) => e.type));
  if (t.has('journal_saved') || t.has('note_saved')) return '✍';
  if (t.has('reminder_set')) return '👌';
  if (t.has('fact_saved') || t.has('profile_updated') || t.has('skill_saved')) return '🤝';
  return null;
}

export async function react(api: ReactApi, chatId: number, messageId: number, emoji: string, log?: Logger): Promise<void> {
  try {
    await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
  } catch (err) {
    log?.warn('reaction failed', { error: telegramErrorOf(err).description });
  }
}
