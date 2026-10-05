/**
 * OpenAI-compatible chat client: streaming, tool calls, retries with backoff, provider fallback,
 * and a guard for reasoning models that spend the whole token budget thinking.
 */
import {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ContentPart,
  FinishReason,
  Logger,
  ModelClient,
  ModelUnavailableError,
  ToolCall,
  Usage,
} from './types';

export interface ProviderConfig {
  name: string;
  /** e.g. https://api.deepseek.com — requests go to {baseUrl}/chat/completions */
  baseUrl: string;
  apiKey: string;
  model: string;
  images: boolean;
  extraHeaders?: Record<string, string>;
  /** Provider understands {"thinking":{"type":"disabled"}}. */
  disableThinkingParam?: boolean;
}

export interface ModelClientOptions {
  providers: ProviderConfig[];
  maxAttemptsPerProvider?: number;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Upper bound for a single HTTP attempt, headers to last byte. */
  totalTimeoutMs?: number;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  log?: Logger;
  /** Injected for deterministic backoff in tests. Returns [0, 1). */
  random?: () => number;
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  const ds = (env.DEEPSEEK_API_KEY || '').trim();
  if (ds) {
    out.push({
      name: 'deepseek',
      baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim(),
      apiKey: ds,
      model: (env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
      images: env.PERSON_MODEL_IMAGES !== '0',
      disableThinkingParam: true,
    });
  }
  const or = (env.OPENROUTER_API_KEY || '').trim();
  if (or) {
    out.push({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: or,
      model: (env.OPENROUTER_MODEL || 'openai/gpt-4o-mini').trim(),
      images: true,
      extraHeaders: { 'HTTP-Referer': 'https://i-journal.local', 'X-Title': 'i-journal' },
    });
  }
  const url = (env.PERSON_MODEL_URL || '').trim();
  const key = (env.PERSON_MODEL_KEY || '').trim();
  const name = (env.PERSON_MODEL_NAME || '').trim();
  if (url && key && name) {
    out.push({ name: 'custom', baseUrl: url, apiKey: key, model: name, images: env.PERSON_MODEL_IMAGES === '1' });
  }
  return out;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);

class AttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly status?: number
  ) {
    super(message);
    this.name = 'AttemptError';
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mapUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const pd = (u.prompt_tokens_details || {}) as Record<string, unknown>;
  const cd = (u.completion_tokens_details || {}) as Record<string, unknown>;
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cachedTokens: num(pd.cached_tokens) || num(u.prompt_cache_hit_tokens),
    reasoningTokens: num(cd.reasoning_tokens),
  };
}

function addUsage(a: Usage, b: Usage | null): void {
  if (!b) return;
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.cachedTokens += b.cachedTokens;
  a.reasoningTokens += b.reasoningTokens;
}

function mapFinish(raw: unknown, hasTools: boolean): FinishReason {
  if (hasTools) return 'tool_calls';
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function joinText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function serializeMessages(messages: ChatMessage[], images: boolean): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: joinText(m.content) };
    if (m.role === 'assistant') {
      const text = joinText(m.content);
      const row: Record<string, unknown> = { role: 'assistant', content: text || (m.tool_calls?.length ? null : '') };
      if (m.tool_calls?.length) {
        row.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
      }
      return row;
    }
    if (m.role === 'system') return { role: 'system', content: joinText(m.content) };
    if (typeof m.content === 'string') return { role: 'user', content: m.content };
    const parts = m.content.map((p) =>
      p.type === 'image_url' && !images ? { type: 'text', text: '[image omitted: this model cannot view images]' } : p
    );
    return { role: 'user', content: parts };
  });
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const at = Date.parse(header);
    if (!Number.isFinite(at)) return undefined;
    ms = at - Date.now();
  }
  return Math.max(0, Math.min(ms, 20_000));
}

interface Pending {
  id?: string;
  name: string;
  args: string;
  order: number;
}

class Accumulator {
  text = '';
  finish: unknown = undefined;
  usage: Usage | null = null;
  done = false;
  badLines = 0;
  private readonly calls = new Map<number, Pending>();
  private seq = 0;

  constructor(private readonly onText: (full: string) => void) {}

  addChunk(obj: Record<string, unknown>): void {
    if (obj.error) {
      const e = obj.error as Record<string, unknown>;
      throw new AttemptError('provider stream error: ' + String(e.message || JSON.stringify(e)).slice(0, 200), true);
    }
    const u = mapUsage(obj.usage);
    if (u) this.usage = u;
    const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
    const choice = choices[0];
    if (!choice) return;
    const delta = (choice.delta || choice.message || {}) as Record<string, unknown>;
    if (typeof delta.content === 'string' && delta.content) {
      this.text += delta.content;
      this.onText(this.text);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls as Array<Record<string, unknown>>) this.addToolDelta(raw);
    }
    if (choice.finish_reason != null) this.finish = choice.finish_reason;
  }

  private addToolDelta(tc: Record<string, unknown>): void {
    const fn = (tc.function || {}) as Record<string, unknown>;
    const id = typeof tc.id === 'string' && tc.id ? tc.id : undefined;
    let index: number;
    if (typeof tc.index === 'number') index = tc.index;
    else if (id && [...this.calls.entries()].some(([, p]) => p.id === id)) index = [...this.calls.entries()].find(([, p]) => p.id === id)![0];
    else if (id || this.calls.size === 0) index = this.calls.size;
    else index = Math.max(...this.calls.keys());
    let p = this.calls.get(index);
    if (!p) {
      p = { name: '', args: '', order: this.seq++ };
      this.calls.set(index, p);
    }
    if (id && !p.id) p.id = id;
    if (typeof fn.name === 'string' && fn.name && !p.name) p.name = fn.name;
    if (typeof fn.arguments === 'string') p.args += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === 'object') p.args += JSON.stringify(fn.arguments);
  }

  toolCalls(): ToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0] || a[1].order - b[1].order)
      .map(([, p]) => p)
      .filter((p) => p.name)
      .map((p, i) => ({ id: p.id || `call_${i}`, name: p.name, arguments: p.args || '{}' }));
  }
}

export function createModelClient(opts: ModelClientOptions): ModelClient {
  const providers = opts.providers;
  const maxAttempts = Math.max(1, opts.maxAttemptsPerProvider ?? 3);
  const firstByteMs = opts.firstByteTimeoutMs ?? 45_000;
  const idleMs = opts.idleTimeoutMs ?? 30_000;
  const totalMs = opts.totalTimeoutMs ?? 120_000;
  const baseMs = opts.backoffBaseMs ?? 600;
  const doFetch = opts.fetchImpl ?? fetch;
  const random = opts.random ?? Math.random;
  const rawSleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!signal) return rawSleep(ms);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      rawSleep(ms).then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      );
    });
  };

  const redact = (s: string, p: ProviderConfig): string => (p.apiKey ? s.split(p.apiKey).join('***') : s);

  async function attempt(
    p: ProviderConfig,
    req: CompletionRequest,
    thinkingOff: boolean,
    onText: (full: string) => void
  ): Promise<{ text: string; toolCalls: ToolCall[]; finish: FinishReason; usage: Usage | null }> {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: serializeMessages(req.messages, p.images),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (req.tools && req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = req.toolChoice ?? 'auto';
    }
    if (thinkingOff) body.thinking = { type: 'disabled' };

    const ac = new AbortController();
    let timeoutKind: string | null = null;
    const onCallerAbort = () => ac.abort();
    if (req.signal?.aborted) throw abortError();
    req.signal?.addEventListener('abort', onCallerAbort, { once: true });
    let timer: NodeJS.Timeout = setTimeout(() => {
      timeoutKind = 'first byte';
      ac.abort();
    }, firstByteMs);
    const total = setTimeout(() => {
      timeoutKind = 'total';
      ac.abort();
    }, totalMs);
    const armIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timeoutKind = 'idle';
        ac.abort();
      }, idleMs);
    };

    let res: Response | undefined;
    try {
      res = await doFetch(p.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + p.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(p.extraHeaders || {}) },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      armIdle();
      if (!res.ok) {
        const text = redact((await res.text().catch(() => '')).slice(0, 200), p);
        const retryable = RETRYABLE_STATUS.has(res.status) || res.status >= 500;
        throw new AttemptError(`${p.name} HTTP ${res.status}: ${text}`, retryable, parseRetryAfter(res.headers.get('retry-after')), res.status);
      }
      const acc = new Accumulator(onText);
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('application/json')) {
        const data = JSON.parse(await res.text()) as Record<string, unknown>;
        acc.addChunk(data);
        acc.done = true;
      } else {
        if (!res.body) throw new AttemptError(`${p.name}: empty response body`, true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        const handleLine = (rawLine: string) => {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (!payload) return;
          if (payload === '[DONE]') {
            acc.done = true;
            return;
          }
          let obj: unknown;
          try {
            obj = JSON.parse(payload);
          } catch {
            acc.badLines++;
            return;
          }
          if (obj && typeof obj === 'object') acc.addChunk(obj as Record<string, unknown>);
        };
        for (;;) {
          const { value, done } = await reader.read();
          armIdle();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            handleLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
          if (acc.done) break;
        }
        buf += decoder.decode();
        if (buf) handleLine(buf);
        if (acc.done) reader.cancel().catch(() => undefined);
      }
      const toolCalls = acc.toolCalls();
      if (!acc.done && acc.finish == null) {
        throw new AttemptError(`${p.name}: stream ended early`, true);
      }
      if (acc.badLines) opts.log?.warn('model: skipped unparseable stream lines', { provider: p.name, count: acc.badLines });
      return { text: acc.text, toolCalls, finish: mapFinish(acc.finish, toolCalls.length > 0), usage: acc.usage };
    } catch (err) {
      res?.body?.cancel().catch(() => undefined);
      if (req.signal?.aborted) throw abortError();
      if (err instanceof AttemptError) throw err;
      if (timeoutKind) throw new AttemptError(`${p.name}: timeout (${timeoutKind})`, true);
      const msg = err instanceof Error ? err.message : String(err);
      throw new AttemptError(`${p.name}: ${redact(msg, p).slice(0, 200)}`, true);
    } finally {
      clearTimeout(timer);
      clearTimeout(total);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    supportsImages: () => providers[0]?.images ?? false,

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      if (!providers.length) throw new ModelUnavailableError('no model provider configured');
      const usage = emptyUsage();
      const causes: string[] = [];
      let attempts = 0;
      let emitted = false;
      const onText = (full: string) => {
        emitted = full.length > 0;
        req.onText?.(full);
      };

      for (const p of providers) {
        let thinkingOff = false;
        for (let n = 1; n <= maxAttempts; n++) {
          if (req.signal?.aborted) throw abortError();
          if (emitted) {
            req.onText?.('');
            emitted = false;
          }
          attempts++;
          let retryAfter: number | undefined;
          try {
            const r = await attempt(p, req, thinkingOff, onText);
            addUsage(usage, r.usage);
            if (!r.text.trim() && !r.toolCalls.length) {
              if (p.disableThinkingParam && !thinkingOff) {
                // Reasoning ate the budget. Same attempt slot, thinking off.
                thinkingOff = true;
                n--;
                opts.log?.warn('model: empty reply, retrying with thinking disabled', { provider: p.name });
                continue;
              }
              throw new AttemptError(`${p.name}: empty reply (finish ${String(r.finish)})`, true);
            }
            return { text: r.text, toolCalls: r.toolCalls, finishReason: r.finish, usage, model: p.model, provider: p.name, attempts };
          } catch (err) {
            if (req.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw abortError();
            const e = err instanceof AttemptError ? err : new AttemptError(String(err), true);
            causes.push(e.message);
            opts.log?.warn('model attempt failed', { provider: p.name, attempt: n, retryable: e.retryable, error: e.message });
            if (!e.retryable) break;
            retryAfter = e.retryAfterMs;
          }
          if (n < maxAttempts) {
            const backoff = Math.min(15_000, baseMs * 2 ** (n - 1) * (0.5 + random() * 0.5));
            await sleep(retryAfter ?? backoff, req.signal);
          }
        }
      }
      throw new ModelUnavailableError(`model unavailable after ${attempts} attempt(s): ${causes[causes.length - 1] || 'unknown error'}`, causes);
    },
  };
}
