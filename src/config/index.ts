import dotenv from 'dotenv';

dotenv.config();

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

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    ownerId: optionalEnv('TELEGRAM_OWNER_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-20250514' as const,
    maxTokens: 1024,
  },
  microsoft: {
    clientId: optionalEnv('MICROSOFT_CLIENT_ID'),
    clientSecret: optionalEnv('MICROSOFT_CLIENT_SECRET'),
    tenantId: optionalEnv('MICROSOFT_TENANT_ID', 'consumers'),
    redirectUri: optionalEnv('MICROSOFT_REDIRECT_URI', 'http://localhost:3000/auth/callback'),
    accessToken: optionalEnv('MICROSOFT_ACCESS_TOKEN'),
    refreshToken: optionalEnv('MICROSOFT_REFRESH_TOKEN'),
  },
  timezone: optionalEnv('TIMEZONE', 'Africa/Nairobi'),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  dbPath: optionalEnv('DB_PATH'),
};

export function hasOwnerOneNoteConfigured(): boolean {
  return Boolean(config.microsoft.accessToken || config.microsoft.refreshToken);
}
