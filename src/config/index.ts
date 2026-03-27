import dotenv from 'dotenv';
import { UserContext } from '../types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    ownerId: requireEnv('TELEGRAM_OWNER_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-20250514' as const,
    maxTokens: 1024,
  },
  microsoft: {
    clientId: requireEnv('MICROSOFT_CLIENT_ID'),
    clientSecret: requireEnv('MICROSOFT_CLIENT_SECRET'),
    tenantId: requireEnv('MICROSOFT_TENANT_ID'),
    redirectUri: process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    accessToken: process.env.MICROSOFT_ACCESS_TOKEN || '',
    refreshToken: process.env.MICROSOFT_REFRESH_TOKEN || '',
  },
  timezone: process.env.TIMEZONE || 'Africa/Nairobi',
  nodeEnv: process.env.NODE_ENV || 'development',
};

export function getFrancisContext(): UserContext {
  return {
    telegramId: config.telegram.ownerId,
    name: 'Francis',
    timezone: config.timezone,
    microsoftAccessToken: config.microsoft.accessToken,
    preferences: {
      morningTime: '06:00',
      eveningTime: '21:00',
    },
  };
}
