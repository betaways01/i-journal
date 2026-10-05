/**
 * Deployment settings, from the environment (.env locally, Railway variables in production).
 * Nothing about any person lives here; see docs/runtime.md for the layering.
 */
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ quiet: true } as dotenv.DotenvConfigOptions);

const env = (key: string, fallback = ''): string => (process.env[key] ?? fallback).trim();

const nodeEnv = env('NODE_ENV', 'development');

function telegramBotToken(): string {
  const primary = env('TELEGRAM_BOT_TOKEN');
  const test = env('TELEGRAM_BOT_TOKEN_TEST');
  if (nodeEnv !== 'production' && test) return test;
  if (primary) return primary;
  if (test) return test;
  throw new Error('Missing TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN_TEST for local testing).');
}

/** Public https address of this server, when it has one (PUBLIC_URL, or Railway's generated domain). */
function publicUrl(): string {
  const explicit = env('PUBLIC_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  const railway = env('RAILWAY_PUBLIC_DOMAIN');
  if (railway) return `https://${railway}`;
  try {
    const u = new URL(env('MICROSOFT_REDIRECT_URI'));
    if (u.protocol === 'https:') return u.origin;
  } catch {
    // not a URL
  }
  return '';
}

function webPort(): number {
  const port = Number.parseInt(env('PORT'), 10);
  if (Number.isFinite(port)) return port;
  try {
    const u = new URL(env('MICROSOFT_REDIRECT_URI'));
    if (u.port) return Number.parseInt(u.port, 10);
  } catch {
    // not a URL
  }
  return 3000;
}

const botToken = telegramBotToken();
const url = publicUrl();
const explicitRedirect = env('MICROSOFT_REDIRECT_URI');

export const config = {
  nodeEnv,
  telegram: {
    botToken,
    ownerId: env('TELEGRAM_OWNER_ID'),
  },
  /** Production with a public https address receives updates by webhook (no polling overlap on deploys). */
  webhook: {
    enabled: nodeEnv === 'production' && url.startsWith('https://') && env('TELEGRAM_WEBHOOK') !== '0',
    publicUrl: url,
    path: '/telegram/webhook',
    // Stable per-bot secret; Telegram sends it back as X-Telegram-Bot-Api-Secret-Token.
    secretToken: crypto.createHash('sha256').update(`ijournal-webhook:${botToken}`).digest('hex').slice(0, 48),
  },
  microsoft: {
    clientId: env('MICROSOFT_CLIENT_ID'),
    clientSecret: env('MICROSOFT_CLIENT_SECRET'),
    /** 'common' lets both personal and work/school accounts sign in directly. */
    tenantId: env('MICROSOFT_TENANT_ID', 'common') || 'common',
    /** Explicit callback, or this server's public address + /auth/callback. */
    redirectUri: explicitRedirect || (url ? `${url}/auth/callback` : ''),
    /** True when the operator set MICROSOFT_REDIRECT_URI (so it is registered in Azure). */
    redirectExplicit: Boolean(explicitRedirect),
  },
  web: { port: webPort() },
  /** Fallback timezone for people who haven't said where they are. */
  timezone: env('TIMEZONE', 'UTC') || 'UTC',
  dbPath: env('DB_PATH'),
  /** Signs OAuth state; defaults to something derived from the bot token. */
  stateSecret: env('OAUTH_STATE_SECRET') || crypto.createHash('sha256').update(`ijournal-oauth:${botToken}`).digest('hex'),
};

export function hasMicrosoftConfigured(): boolean {
  return Boolean(config.microsoft.clientId);
}
