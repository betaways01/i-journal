/**
 * Logging. Production writes one JSON object per line (Railway and most log tools can search and
 * filter on the fields); development writes a readable line. Secrets never reach the output: fields
 * named like keys/tokens are masked, and token-shaped strings are masked wherever they appear.
 */
import { Logger } from './types';

// Names that end like a credential ("botToken", "client_secret", "apiKey"); "promptTokens" is not one.
const SECRET_FIELD = /(token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|credential)$/i;
const SECRET_VALUE: RegExp[] = [
  /\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, // Telegram bot token inside API URLs
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // bare Telegram bot token
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/DeepSeek/OpenRouter-style keys
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // Groq
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT / Microsoft access tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE) out = out.replace(re, '[redacted]');
  return out;
}

function clean(value: unknown, key = '', depth = 0): unknown {
  if (key && SECRET_FIELD.test(key) && value != null && value !== '') return '[redacted]';
  if (typeof value === 'string') return redact(value.length > 4000 ? value.slice(0, 4000) + '…' : value);
  if (value instanceof Error) return redact(value.stack || value.message);
  if (Array.isArray(value)) return depth > 4 ? '[…]' : value.slice(0, 50).map((v) => clean(v, '', depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 4) return '[…]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v, k, depth + 1);
    return out;
  }
  return value;
}

export interface LoggerOptions {
  /** JSON lines (default: NODE_ENV=production). */
  json?: boolean;
  /** Fields added to every line, e.g. { app: 'i-journal', version }. */
  base?: Record<string, unknown>;
  /** Where lines go (default: console). */
  write?: (level: 'info' | 'warn' | 'error', line: string) => void;
  scope?: string;
}

export function createLogger(opts: LoggerOptions = {}): Logger & { child(scope: string, base?: Record<string, unknown>): Logger } {
  const json = opts.json ?? process.env.NODE_ENV === 'production';
  const write =
    opts.write ??
    ((level, line) => {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    });
  const make = (scope: string | undefined, base: Record<string, unknown>) => {
    const emit = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      const fields = data ? (clean(data) as Record<string, unknown>) : undefined;
      if (json) {
        write(level, JSON.stringify({ t: new Date().toISOString(), level, ...(scope ? { scope } : {}), msg: redact(msg), ...base, ...fields }));
      } else {
        const tail = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
        write(level, `${new Date().toISOString().slice(11, 19)} ${level === 'info' ? ' ' : level === 'warn' ? '!' : '✖'} ${scope ? `[${scope}] ` : ''}${redact(msg)}${tail}`);
      }
    };
    return {
      info: (m: string, d?: Record<string, unknown>) => emit('info', m, d),
      warn: (m: string, d?: Record<string, unknown>) => emit('warn', m, d),
      error: (m: string, d?: Record<string, unknown>) => emit('error', m, d),
    };
  };
  const root = make(opts.scope, opts.base ?? {});
  return { ...root, child: (scope: string, base: Record<string, unknown> = {}) => make(scope, { ...(opts.base ?? {}), ...base }) };
}
