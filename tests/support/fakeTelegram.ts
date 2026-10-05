/**
 * A fake Telegram Bot API server for end-to-end tests. Point telegraf at it with
 * `new Telegraf(token, { telegram: { apiRoot: fake.apiRoot } })`. It long-polls like the real API
 * and enforces the constraints that make real bots fail (length, HTML entities, blocked users,
 * flood control, a second poller), so tests catch what Telegram would reject.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { validateTelegramHtml, visibleText } from '../../src/bot/render';

type Json = Record<string, unknown>;

export interface FakeMessage {
  message_id: number;
  fromBot: boolean;
  text?: string;
  caption?: string;
  parse_mode?: string;
  plain: string;
  reply_markup?: unknown;
  reply_to?: number;
  edits: string[];
  deleted: boolean;
  reactions: unknown[];
  raw: Json;
  /** For documents the bot sent. */
  document?: { fileName: string; content: string; caption?: string };
}

export interface FakeCall {
  seq: number;
  at: number;
  method: string;
  payload: Json;
}

interface ChatState {
  messages: FakeMessage[];
  actions: Array<{ action: string; at: number }>;
}

interface Fault {
  error_code: number;
  description: string;
  parameters?: Json;
  times: number;
}

const BOT = { id: 900000001, is_bot: true, first_name: 'i-Journal-test', username: 'fake_ijournal_bot' };

export class FakeTelegram {
  readonly token: string;
  apiRoot = '';
  readonly calls: FakeCall[] = [];
  readonly unknownCalls: FakeCall[] = [];
  private server!: http.Server;
  private seq = 0;
  private updateId = 1000;
  private msgId = 1;
  private readonly queue: Json[] = [];
  private readonly waiters = new Set<() => void>();
  private activePoll: { res: http.ServerResponse; finish: () => void } | null = null;
  private readonly chats = new Map<number, ChatState>();
  private readonly known = new Set<number>();
  private readonly blocked = new Set<number>();
  private readonly faults = new Map<string, Fault[]>();
  private readonly delays = new Map<string, number>();
  private readonly files = new Map<string, { path: string; bytes: Buffer }>();
  private readonly listeners = new Set<() => void>();
  private rate?: { perChatPerSecond: number; recent: Map<number, number[]> };
  strict = false;

  private constructor(token: string) {
    this.token = token;
  }

  static async start(opts: { token?: string; strict?: boolean } = {}): Promise<FakeTelegram> {
    const fake = new FakeTelegram(opts.token || '123456:TEST-TOKEN');
    fake.strict = Boolean(opts.strict);
    fake.server = http.createServer((req, res) => {
      void fake.route(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error_code: 500, description: String(err) }));
      });
    });
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    fake.apiRoot = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    return fake;
  }

  async stop(): Promise<void> {
    this.activePoll?.finish();
    for (const w of this.waiters) w();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // -------------------------------------------------------------------------
  // fault injection
  // -------------------------------------------------------------------------

  failNext(method: string, err: { error_code: number; description: string; parameters?: Json }, times = 1): void {
    const list = this.faults.get(method) || [];
    list.push({ ...err, times });
    this.faults.set(method, list);
  }

  delay(method: string, ms: number): void {
    this.delays.set(method, ms);
  }

  rateLimit(opts: { perChatPerSecond: number } | null): void {
    this.rate = opts ? { perChatPerSecond: opts.perChatPerSecond, recent: new Map() } : undefined;
  }

  block(userId: number, on = true): void {
    if (on) this.blocked.add(userId);
    else this.blocked.delete(userId);
  }

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------

  chat(chatId: number): ChatState {
    let c = this.chats.get(chatId);
    if (!c) {
      c = { messages: [], actions: [] };
      this.chats.set(chatId, c);
    }
    return c;
  }

  botMessages(chatId: number): FakeMessage[] {
    return this.chat(chatId).messages.filter((m) => m.fromBot && !m.deleted);
  }

  botTexts(chatId: number): string[] {
    return this.botMessages(chatId).map((m) => m.plain);
  }

  lastBotText(chatId: number): string | undefined {
    return this.botMessages(chatId).at(-1)?.plain;
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls.length = 0;
    this.unknownCalls.length = 0;
    this.chats.clear();
    this.faults.clear();
    this.delays.clear();
    this.blocked.clear();
    this.rate = undefined;
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Resolves when `predicate` is true, re-checking on every API call and every 20ms. */
  waitFor(predicate: () => boolean, opts: { timeoutMs?: number; label?: string } = {}): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(poll);
        this.listeners.delete(check);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`waitFor timed out: ${opts.label || 'condition'}`));
      }, opts.timeoutMs ?? 5000);
      const check = () => {
        if (!predicate()) return;
        done();
        resolve();
      };
      const poll = setInterval(check, 20);
      this.listeners.add(check);
    });
  }

  /** Waits for the bot's Nth message in a chat (counting from 1). */
  async waitForBotMessages(chatId: number, count: number, timeoutMs = 5000): Promise<FakeMessage[]> {
    await this.waitFor(() => this.botMessages(chatId).length >= count, { timeoutMs, label: `${count} bot message(s) in ${chatId}` });
    return this.botMessages(chatId);
  }

  /** Resolves once no API call has happened for `quietMs`. */
  async waitForIdle(quietMs = 150, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const last = this.calls.at(-1)?.at ?? 0;
      if (Date.now() - last >= quietMs && !this.queue.length) return;
      if (Date.now() - start > timeoutMs) throw new Error('waitForIdle timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // -------------------------------------------------------------------------
  // user activity
  // -------------------------------------------------------------------------

  private user(userId: number, firstName = 'Sam', username?: string): Json {
    return { id: userId, is_bot: false, first_name: firstName, ...(username ? { username } : {}) };
  }

  private baseMessage(userId: number, opts: { firstName?: string; replyTo?: number; quote?: string; forward?: boolean } = {}): Json {
    this.known.add(userId);
    const msg: Json = {
      message_id: this.msgId++,
      from: this.user(userId, opts.firstName),
      chat: { id: userId, type: 'private', first_name: opts.firstName || 'Sam' },
      date: Math.floor(Date.now() / 1000),
    };
    if (opts.replyTo) {
      const target = this.chat(userId).messages.find((m) => m.message_id === opts.replyTo);
      if (target) msg.reply_to_message = target.raw;
    }
    if (opts.quote) msg.quote = { text: opts.quote, position: 0 };
    if (opts.forward) {
      msg.forward_origin = { type: 'hidden_user', sender_user_name: 'Someone', date: Math.floor(Date.now() / 1000) - 60 };
      msg.forward_date = Math.floor(Date.now() / 1000) - 60;
    }
    return msg;
  }

  private record(userId: number, msg: Json): Json {
    this.chat(userId).messages.push({
      message_id: msg.message_id as number,
      fromBot: false,
      text: msg.text as string | undefined,
      caption: msg.caption as string | undefined,
      plain: String(msg.text ?? msg.caption ?? ''),
      edits: [],
      deleted: false,
      reactions: [],
      raw: msg,
    });
    return msg;
  }

  private push(update: Json): Json {
    update.update_id = this.updateId++;
    this.queue.push(update);
    for (const w of [...this.waiters]) w();
    return update;
  }

  build = {
    text: (userId: number, text: string, opts: { replyTo?: number; quote?: string; forward?: boolean; firstName?: string } = {}): Json => {
      const msg = { ...this.baseMessage(userId, opts), text };
      if (text.startsWith('/')) (msg as Json).entities = [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }];
      return { message: this.record(userId, msg) };
    },
  };

  sendText(userId: number, text: string, opts: { replyTo?: number; quote?: string; forward?: boolean; firstName?: string } = {}): Json {
    const upd = this.build.text(userId, text, opts);
    this.push(upd);
    return upd.message as Json;
  }

  sendCommand(userId: number, command: string): Json {
    return this.sendText(userId, command.startsWith('/') ? command : '/' + command);
  }

  private registerFile(kind: string, bytes: Buffer): { file_id: string; file_unique_id: string; file_size: number } {
    const n = this.files.size + 1;
    const file_id = `${kind}-file-${n}`;
    this.files.set(file_id, { path: `${kind}s/file_${n}.${kind === 'photo' ? 'jpg' : kind === 'voice' ? 'oga' : 'bin'}`, bytes });
    return { file_id, file_unique_id: `u${n}`, file_size: bytes.length };
  }

  sendPhoto(userId: number, opts: { caption?: string; bytes?: Buffer; replyTo?: number; mediaGroupId?: string; forward?: boolean } = {}): Json {
    const f = this.registerFile('photo', opts.bytes || Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const msg: Json = {
      ...this.baseMessage(userId, { replyTo: opts.replyTo, forward: opts.forward }),
      photo: [
        { ...f, file_id: f.file_id + '-small', width: 90, height: 90 },
        { ...f, width: 1280, height: 960 },
      ],
    };
    if (opts.caption) msg.caption = opts.caption;
    if (opts.mediaGroupId) msg.media_group_id = opts.mediaGroupId;
    this.files.set(f.file_id + '-small', this.files.get(f.file_id)!);
    this.push({ message: this.record(userId, msg) });
    return msg;
  }

  sendAlbum(userId: number, items: Array<{ caption?: string; bytes?: Buffer }>): Json[] {
    const gid = 'album-' + this.msgId;
    return items.map((it) => this.sendPhoto(userId, { ...it, mediaGroupId: gid }));
  }

  sendVoice(userId: number, opts: { duration?: number; bytes?: Buffer } = {}): Json {
    const f = this.registerFile('voice', opts.bytes || Buffer.from('OggS-fake-voice'));
    const msg = { ...this.baseMessage(userId), voice: { ...f, duration: opts.duration ?? 5, mime_type: 'audio/ogg' } };
    this.push({ message: this.record(userId, msg) });
    return msg;
  }

  sendVideoNote(userId: number, opts: { duration?: number } = {}): Json {
    const f = this.registerFile('video_note', Buffer.from('fake-mp4'));
    const msg = { ...this.baseMessage(userId), video_note: { ...f, duration: opts.duration ?? 4, length: 240 } };
    this.push({ message: this.record(userId, msg) });
    return msg;
  }

  sendDocument(userId: number, opts: { fileName?: string; mime?: string; caption?: string } = {}): Json {
    const f = this.registerFile('document', Buffer.from('%PDF-fake'));
    const msg: Json = { ...this.baseMessage(userId), document: { ...f, file_name: opts.fileName || 'file.pdf', mime_type: opts.mime || 'application/pdf' } };
    if (opts.caption) msg.caption = opts.caption;
    this.push({ message: this.record(userId, msg) });
    return msg;
  }

  sendSticker(userId: number, emoji = '🙂'): Json {
    const msg = { ...this.baseMessage(userId), sticker: { file_id: 'sticker-1', file_unique_id: 's1', type: 'regular', width: 512, height: 512, is_animated: false, is_video: false, emoji } };
    this.push({ message: this.record(userId, msg) });
    return msg;
  }

  editText(userId: number, messageId: number, text: string): Json {
    const msg = { ...this.baseMessage(userId), message_id: messageId, text, edit_date: Math.floor(Date.now() / 1000) };
    this.push({ edited_message: msg });
    return msg;
  }

  /** The person sets (or clears, with '') a reaction on a message. */
  react(userId: number, messageId: number, emoji: string): Json {
    const update = {
      chat: { id: userId, type: 'private' },
      message_id: messageId,
      user: this.user(userId),
      date: Math.floor(Date.now() / 1000),
      old_reaction: [],
      new_reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    };
    this.known.add(userId);
    this.push({ message_reaction: update });
    return update;
  }

  pressButton(userId: number, messageId: number, data: string): Json {
    const message = this.chat(userId).messages.find((m) => m.message_id === messageId)?.raw || { message_id: messageId, chat: { id: userId, type: 'private' }, date: 0 };
    const cq = { id: 'cq' + this.updateId, from: this.user(userId), message, chat_instance: 'ci', data };
    this.known.add(userId);
    this.push({ callback_query: cq });
    return cq;
  }

  /** A message from someone in a group chat (bots here ignore groups). */
  sendGroupText(userId: number, groupId: number, text: string): Json {
    const msg = { message_id: this.msgId++, from: this.user(userId), chat: { id: groupId, type: 'group', title: 'G' }, date: Math.floor(Date.now() / 1000), text };
    this.push({ message: msg });
    return msg;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async readBody(req: http.IncomingMessage): Promise<Json> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url || '/', 'http://x');
    const fromQuery = Object.fromEntries(url.searchParams.entries());
    if (!raw) return fromQuery;
    const ctype = String(req.headers['content-type'] || '');
    if (ctype.includes('application/json')) return { ...fromQuery, ...(JSON.parse(raw) as Json) };
    if (ctype.includes('application/x-www-form-urlencoded')) return { ...fromQuery, ...Object.fromEntries(new URLSearchParams(raw).entries()) };
    if (ctype.includes('multipart/form-data')) {
      const boundary = /boundary=(.+)$/.exec(ctype)?.[1] || '';
      const out: Json = { ...fromQuery };
      for (const part of raw.split('--' + boundary)) {
        const m = /name="([^"]+)"([^\r\n]*)\r\n(?:[^\r\n]*\r\n)*\r\n([\s\S]*?)\r\n$/.exec(part);
        if (!m) continue;
        out[m[1]] = m[3];
        const file = /filename="([^"]*)"/.exec(m[2]);
        if (file) out[`${m[1]}_filename`] = file[1];
      }
      return out;
    }
    return fromQuery;
  }

  private send(res: http.ServerResponse, status: number, body: Json): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, error_code: number, description: string, parameters?: Json): void {
    this.send(res, error_code, { ok: false, error_code, description, ...(parameters ? { parameters } : {}) });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://x');
    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (fileMatch) {
      if (fileMatch[1] !== this.token) return this.fail(res, 401, 'Unauthorized');
      const file = [...this.files.values()].find((f) => f.path === fileMatch[2]);
      if (!file) return this.fail(res, 404, 'Not Found');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(file.bytes);
      return;
    }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!m) return this.fail(res, 404, 'Not Found');
    if (m[1] !== this.token) return this.fail(res, 401, 'Unauthorized');
    const method = m[2];
    const payload = await this.readBody(req);
    const call: FakeCall = { seq: ++this.seq, at: Date.now(), method, payload };
    if (method !== 'getUpdates') this.calls.push(call);

    const delay = this.delays.get(method);
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const faults = this.faults.get(method);
    if (faults && faults.length) {
      const f = faults[0];
      if (--f.times <= 0) faults.shift();
      this.notify();
      return this.fail(res, f.error_code, f.description, f.parameters);
    }

    try {
      await this.dispatch(method, payload, res, call);
    } finally {
      this.notify();
    }
  }

  private chatIdOf(payload: Json): number {
    return Number(payload.chat_id);
  }

  private checkChat(res: http.ServerResponse, payload: Json): number | null {
    const chatId = this.chatIdOf(payload);
    if (!Number.isFinite(chatId) || !this.known.has(chatId)) {
      this.fail(res, 400, 'Bad Request: chat not found');
      return null;
    }
    if (this.blocked.has(chatId)) {
      this.fail(res, 403, 'Forbidden: bot was blocked by the user');
      return null;
    }
    if (this.rate) {
      const now = Date.now();
      const recent = (this.rate.recent.get(chatId) || []).filter((t) => now - t < 1000);
      if (recent.length >= this.rate.perChatPerSecond) {
        this.fail(res, 429, 'Too Many Requests: retry after 1', { retry_after: 1 });
        return null;
      }
      recent.push(now);
      this.rate.recent.set(chatId, recent);
    }
    return chatId;
  }

  private checkText(res: http.ServerResponse, text: unknown, parseMode: unknown, limit = 4096): string | null {
    const raw = typeof text === 'string' ? text : '';
    if (!raw.trim()) {
      this.fail(res, 400, 'Bad Request: message text is empty');
      return null;
    }
    let plain = raw;
    if (parseMode === 'HTML') {
      const v = validateTelegramHtml(raw.length > limit * 4 ? raw.slice(0, limit * 4) : raw);
      if (!v.ok && !/too long/.test(v.error || '')) {
        this.fail(res, 400, `Bad Request: can't parse entities: ${v.error}`);
        return null;
      }
      plain = visibleText(raw);
    } else if (parseMode === 'MarkdownV2') {
      if (/(?<!\\)[_*[\]()~`>#+\-=|{}.!]/.test(raw.replace(/\\./g, ''))) {
        this.fail(res, 400, "Bad Request: can't parse entities: Character is reserved and must be escaped");
        return null;
      }
    }
    if (plain.length > limit) {
      this.fail(res, 400, limit === 1024 ? 'Bad Request: message caption is too long' : 'Bad Request: message is too long');
      return null;
    }
    return plain;
  }

  private async dispatch(method: string, p: Json, res: http.ServerResponse, call: FakeCall): Promise<void> {
    switch (method) {
      case 'getMe':
        return this.send(res, 200, { ok: true, result: { ...BOT, can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } });
      case 'getUpdates':
        return this.getUpdates(p, res);
      case 'deleteWebhook':
        if (p.drop_pending_updates === true || p.drop_pending_updates === 'true') this.queue.length = 0;
        return this.send(res, 200, { ok: true, result: true });
      case 'setWebhook':
        return this.send(res, 200, { ok: true, result: true });
      case 'getWebhookInfo':
        return this.send(res, 200, { ok: true, result: { url: '', has_custom_certificate: false, pending_update_count: this.queue.length } });
      case 'setMyCommands':
        return this.send(res, 200, { ok: true, result: true });
      case 'getMyCommands':
        return this.send(res, 200, { ok: true, result: [] });
      case 'sendChatAction': {
        const chatId = this.checkChat(res, p);
        if (chatId === null) return;
        this.chat(chatId).actions.push({ action: String(p.action), at: Date.now() });
        return this.send(res, 200, { ok: true, result: true });
      }
      case 'sendMessage': {
        const chatId = this.checkChat(res, p);
        if (chatId === null) return;
        const plain = this.checkText(res, p.text, p.parse_mode);
        if (plain === null) return;
        const rp = p.reply_parameters as Json | undefined;
        const replyTo = rp ? Number(rp.message_id) : undefined;
        if (replyTo && !rp?.allow_sending_without_reply && !this.chat(chatId).messages.some((m) => m.message_id === replyTo)) {
          return this.fail(res, 400, 'Bad Request: message to be replied not found');
        }
        const raw: Json = { message_id: this.msgId++, from: BOT, chat: { id: chatId, type: 'private' }, date: Math.floor(Date.now() / 1000), text: plain };
        this.chat(chatId).messages.push({
          message_id: raw.message_id as number,
          fromBot: true,
          text: String(p.text),
          parse_mode: p.parse_mode as string | undefined,
          plain,
          reply_markup: p.reply_markup,
          reply_to: replyTo,
          edits: [],
          deleted: false,
          reactions: [],
          raw,
        });
        return this.send(res, 200, { ok: true, result: raw });
      }
      case 'sendDocument': {
        const chatId = this.checkChat(res, p);
        if (chatId === null) return;
        const raw: Json = { message_id: this.msgId++, from: BOT, chat: { id: chatId, type: 'private' }, date: Math.floor(Date.now() / 1000), document: { file_name: 'file' } };
        this.chat(chatId).messages.push({
          message_id: raw.message_id as number,
          fromBot: true,
          caption: p.caption as string | undefined,
          plain: String(p.caption ?? ''),
          edits: [],
          deleted: false,
          reactions: [],
          raw,
          document: { fileName: String(p.document_filename ?? 'file'), content: String(p.document ?? ''), caption: p.caption as string | undefined },
        });
        return this.send(res, 200, { ok: true, result: raw });
      }
      case 'editMessageText': {
        const chatId = this.checkChat(res, p);
        if (chatId === null) return;
        const msg = this.chat(chatId).messages.find((m) => m.message_id === Number(p.message_id) && m.fromBot && !m.deleted);
        if (!msg) return this.fail(res, 400, 'Bad Request: message to edit not found');
        const plain = this.checkText(res, p.text, p.parse_mode);
        if (plain === null) return;
        if (String(p.text) === msg.text && JSON.stringify(p.reply_markup ?? null) === JSON.stringify(msg.reply_markup ?? null)) {
          return this.fail(res, 400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
        }
        msg.edits.push(msg.plain);
        msg.text = String(p.text);
        msg.plain = plain;
        msg.parse_mode = p.parse_mode as string | undefined;
        if (p.reply_markup !== undefined) msg.reply_markup = p.reply_markup;
        return this.send(res, 200, { ok: true, result: { ...msg.raw, text: plain } });
      }
      case 'deleteMessage': {
        const chatId = this.checkChat(res, p);
        if (chatId === null) return;
        const msg = this.chat(chatId).messages.find((m) => m.message_id === Number(p.message_id) && !m.deleted);
        if (!msg) return this.fail(res, 400, 'Bad Request: message to delete not found');
        msg.deleted = true;
        return this.send(res, 200, { ok: true, result: true });
      }
      case 'setMessageReaction': {
        const chatId = this.checkChat(res, p);
        if (chatId === null) return;
        const msg = this.chat(chatId).messages.find((m) => m.message_id === Number(p.message_id));
        if (!msg) return this.fail(res, 400, 'Bad Request: message to react not found');
        msg.reactions.push(p.reaction);
        return this.send(res, 200, { ok: true, result: true });
      }
      case 'answerCallbackQuery':
        return this.send(res, 200, { ok: true, result: true });
      case 'editMessageReplyMarkup':
        return this.send(res, 200, { ok: true, result: true });
      case 'getFile': {
        const f = this.files.get(String(p.file_id));
        if (!f) return this.fail(res, 400, 'Bad Request: invalid file_id');
        return this.send(res, 200, { ok: true, result: { file_id: p.file_id, file_unique_id: 'u', file_size: f.bytes.length, file_path: f.path } });
      }
      case 'getChat':
        return this.send(res, 200, { ok: true, result: { id: Number(p.chat_id), type: 'private' } });
      default:
        this.unknownCalls.push(call);
        if (this.strict) return this.fail(res, 404, 'Not Found: method not found');
        return this.send(res, 200, { ok: true, result: true });
    }
  }

  private getUpdates(p: Json, res: http.ServerResponse): void {
    const offset = Number(p.offset || 0);
    if (offset) while (this.queue.length && (this.queue[0].update_id as number) < offset) this.queue.shift();
    const limit = Math.max(1, Math.min(100, Number(p.limit || 100)));
    const timeoutS = Math.min(Number(p.timeout || 0), 50);

    if (this.activePoll) {
      const older = this.activePoll;
      this.activePoll = null;
      this.fail(older.res, 409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running');
      older.finish();
    }
    const respond = () => this.send(res, 200, { ok: true, result: this.queue.slice(0, limit) });
    if (this.queue.length || timeoutS <= 0) return respond();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.waiters.delete(wake);
      if (this.activePoll?.res === res) this.activePoll = null;
    };
    const wake = () => {
      if (done) return;
      finish();
      respond();
    };
    const timer = setTimeout(wake, timeoutS * 1000);
    timer.unref();
    this.waiters.add(wake);
    this.activePoll = { res, finish };
    res.on('close', finish);
  }
}
