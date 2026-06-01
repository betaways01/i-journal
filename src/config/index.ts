import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = optionalEnv('NODE_ENV', 'development');

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function optionalIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getWebPort(): number {
  const explicitPort = process.env.PORT;
  if (explicitPort) {
    const parsed = Number.parseInt(explicitPort, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      if (url.port) {
        const parsed = Number.parseInt(url.port, 10);
        if (Number.isFinite(parsed)) return parsed;
      }

      if (url.protocol === 'https:') return 443;
      if (url.protocol === 'http:') return 80;
    } catch {
      // ignore malformed redirect URI and fall back
    }
  }

  return 3000;
}

function requireTelegramBotToken(currentNodeEnv: string): string {
  const primaryToken = process.env.TELEGRAM_BOT_TOKEN;
  const testToken = process.env.TELEGRAM_BOT_TOKEN_TEST;

  if (currentNodeEnv !== 'production' && testToken) {
    return testToken;
  }

  if (primaryToken) {
    return primaryToken;
  }

  if (testToken) {
    return testToken;
  }

  throw new Error(
    'Missing required environment variable: TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN_TEST'
  );
}

export const config = {
  telegram: {
    botToken: requireTelegramBotToken(nodeEnv),
    ownerId: optionalEnv('TELEGRAM_OWNER_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    // Current Sonnet — far stronger at following instructions and using tools than the
    // original sonnet-4-20250514, which is the root of the "not helpful / too literal" feel.
    // Override with ANTHROPIC_MODEL if needed.
    model: optionalEnv('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    // Room for a full compiled journal entry plus a natural reply. The old 1024 cap
    // clipped responses mid-thought.
    maxTokens: optionalIntEnv('ANTHROPIC_MAX_TOKENS', 2048),
  },
  microsoft: {
    clientId: optionalEnv('MICROSOFT_CLIENT_ID'),
    clientSecret: optionalEnv('MICROSOFT_CLIENT_SECRET'),
    // Microsoft sign-in authority. 'common' supports BOTH personal (outlook/hotmail/live) and
    // work/school accounts, so the user can connect whichever account's OneNote actually works.
    // (Graph OneNote can fail for either type — the "Tenant does not have a SPO license" error
    // is about license/provisioning/auth-context, NOT account type; work/school is often the
    // more reliable path.) The app probes the connection at connect time and falls back to
    // local saving on failure. If a personal account is wrongly treated as an org guest and hits
    // the SPO-license error, setting MICROSOFT_TENANT_ID=consumers (with the Azure app reg
    // allowing personal accounts) is a known fix for that specific case.
    tenantId: optionalEnv('MICROSOFT_TENANT_ID', 'common') || 'common',
    redirectUri: optionalEnv('MICROSOFT_REDIRECT_URI', 'http://localhost:3000/auth/callback'),
    accessToken: optionalEnv('MICROSOFT_ACCESS_TOKEN'),
    refreshToken: optionalEnv('MICROSOFT_REFRESH_TOKEN'),
  },
  web: {
    port: getWebPort(),
  },
  timezone: optionalEnv('TIMEZONE', 'Africa/Nairobi'),
  nodeEnv,
  dbPath: optionalEnv('DB_PATH'),
};

export function hasLegacyOwnerOneNoteConfigured(): boolean {
  return Boolean(config.microsoft.accessToken || config.microsoft.refreshToken);
}

export function hasOwnerOneNoteConfigured(): boolean {
  return hasLegacyOwnerOneNoteConfigured();
}

export function hasMicrosoftOAuthConfigured(): boolean {
  return Boolean(
    config.microsoft.clientId &&
      config.microsoft.clientSecret &&
      config.microsoft.redirectUri
  );
}
