import { Context, Telegraf } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/types';
import { listOnboardedUsers, UserRow } from '../../db/users.repo';
import { getProfileForUser, needsReviewForUser } from '../../db/profile.repo';
import {
  sessionStore,
  getJournalState,
  getTodayDateStringInZone,
  getYesterdayDateStringInZone,
} from '../../state/session.store';
import { getLastEntry } from '../../db/entries.repo';
import { startMorningSession } from '../scenes/morning.scene';
import { startEveningSession } from '../scenes/evening.scene';
import { startOnboarding, skipOnboarding } from '../scenes/onboarding.scene';
import { startSettings } from '../scenes/settings.scene';
import { registerUserFromContext, loadBotUser } from '../userContext';
import { hasMicrosoftOAuthConfigured } from '../../config';
import { buildMicrosoftAuthUrlForUser } from '../../onenote/auth';
import { getOneNoteStatusForUser } from '../../onenote/writer';

async function ensureOnboardedOrGuide(
  ctx: Context,
  userRow: UserRow,
  actionName: string
): Promise<boolean> {
  if (userRow.onboarding_complete === 1) return true;

  await ctx.reply(
    actionName === 'start'
      ? '🌅 *Welcome to i-Journal!*\n\nLet me set up your personal journal. I\'ll ask a few quick questions to customize it for you.\n\n_Use /skip anytime to use defaults instead._'
      : 'Let\'s set up your journal first — use /start.',
    { parse_mode: 'Markdown' }
  );
  if (actionName === 'start') {
    await startOnboarding(ctx, String(userRow.telegram_id));
  }
  return false;
}

export function registerCommands(bot: Telegraf): void {
  bot.command('start', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;

    const telegramId = userRow.telegram_id;

    if (userRow.onboarding_complete === 0) {
      await ctx.reply(
        '🌅 *Welcome to i-Journal!*\n\nI\'ll set up your personal journal with a few quick questions.\n\n_Use /skip anytime to use defaults._',
        { parse_mode: 'Markdown' }
      );
      await startOnboarding(ctx, telegramId);
      return;
    }

    const profile = getProfileForUser(userRow.id);
    if (!profile) {
      await startOnboarding(ctx, telegramId);
      return;
    }

    await ctx.reply(
      `🌅 *Welcome back, ${profile.name}!*\n\n` +
        `☀️ /morning — Start your morning check-in\n` +
        `📖 /journal — Start your evening journal\n` +
        `📝 /catchup — Journal yesterday's entry\n` +
        `⚙️ /settings — Adjust sections or schedule\n` +
        `⏭️ /skip — Skip current session\n` +
        `📊 /status — Check today's session status\n` +
        `📄 /last — Show your last journal entry\n` +
        `💾 /storage — Cloud save options\n` +
        `❤️ /health — Bot status\n\n` +
        `I'll reach out at *${profile.morningTime}* and *${profile.eveningTime}* each day.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('morning', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'morning'))) return;

    const telegramId = userRow.telegram_id;
    if (sessionStore.has(telegramId)) {
      await ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }
    await startMorningSession(ctx, telegramId);
  });

  bot.command('journal', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'journal'))) return;

    const telegramId = userRow.telegram_id;
    if (sessionStore.has(telegramId)) {
      await ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }

    if (needsReviewForUser(userRow.id)) {
      await ctx.reply(
        '💡 You\'ve been journaling for a while! Your sections or schedule might need a refresh. Type /settings anytime to adjust.'
      );
    }

    await startEveningSession(ctx, telegramId);
  });

  bot.command('catchup', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'catchup'))) return;

    const telegramId = userRow.telegram_id;
    const botUser = loadBotUser(telegramId);
    if (!botUser) return;

    if (sessionStore.has(telegramId)) {
      await ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }

    const yesterday = getYesterdayDateStringInZone(botUser.profile.timezone);
    const state = getJournalState(telegramId);

    if (state.lastEveningDate === yesterday) {
      await ctx.reply('Yesterday is already journaled — nothing to catch up. Use /journal for today.');
      return;
    }

    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);

    await ctx.reply(`📝 Catching up on ${yesterday} — I'll save this under yesterday's date.`);
    await startEveningSession(ctx, telegramId, yesterdayDate);
  });

  bot.command('settings', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'settings'))) return;

    const telegramId = userRow.telegram_id;
    if (sessionStore.has(telegramId)) {
      await ctx.reply('You have an active session. Finish or /skip it first.');
      return;
    }
    await startSettings(ctx, telegramId);
  });

  bot.command('skip', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    const telegramId = userRow.telegram_id;

    if (sessionStore.has(telegramId)) {
      const session = sessionStore.get(telegramId);

      if (session?.sessionType === 'onboarding') {
        skipOnboarding(telegramId);
        await ctx.reply('Setup skipped — using defaults. Customize anytime with /settings. 🙂');
        return;
      }

      sessionStore.clear(telegramId);
      await ctx.reply('Session skipped. Rest well. Tomorrow is a new day. 🌙');
    } else {
      await ctx.reply('No active session to skip.');
    }
  });

  bot.command('status', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    const telegramId = userRow.telegram_id;
    const botUser = loadBotUser(telegramId);
    if (!botUser) return;

    const state = getJournalState(telegramId);
    const today = getTodayDateStringInZone(botUser.profile.timezone);

    const morningDone = state.lastMorningDate === today;
    const eveningDone = state.lastEveningDate === today;

    const activeSession = sessionStore.get(telegramId);

    let status = `📊 *Journal Status — ${today}*\n\n`;
    status += `☀️ Morning: ${morningDone ? '✅ Done' : '⏳ Pending'}\n`;
    status += `🌙 Evening: ${eveningDone ? '✅ Done' : '⏳ Pending'}\n`;

    if (activeSession) {
      status += `\n🔄 Active session: ${activeSession.sessionType}`;
    }

    status += `\n\n📋 Sections: ${botUser.profile.sections.map((s) => s.emoji).join(' ')}`;

    await ctx.reply(status, { parse_mode: 'Markdown' });
  });

  bot.command('last', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;

    const entry = getLastEntry(userRow.id);
    if (!entry) {
      await ctx.reply('No entries yet — start with /journal or /morning.');
      return;
    }

    const header = `📄 *Last entry — ${entry.entry_date} (${entry.day_of_week})*\n\n`;
    const body = entry.content_markdown.length > 3500
      ? entry.content_markdown.slice(0, 3500) + '\n\n…(truncated)'
      : entry.content_markdown;
    const cloudNote = entry.onenote_url
      ? `\n\n[Open in OneNote](${entry.onenote_url})`
      : entry.saved_to_cloud === 0 && getOneNoteStatusForUser(userRow).connected
        ? '\n\n_(not yet synced to OneNote)_'
        : '';
    await ctx.reply(header + body + cloudNote, { parse_mode: 'Markdown' });
  });

  bot.command('storage', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;

    const oneNote = getOneNoteStatusForUser(userRow);
    const oauthReady = hasMicrosoftOAuthConfigured();
    const lines = [
      '💾 *Storage*',
      '',
      `• Local database: ✅ active (your entries are always saved here first)`,
      `• OneNote sync: ${
        oneNote.connected
          ? oneNote.source === 'legacy_owner_env'
            ? '✅ connected (legacy server account)'
            : '✅ connected'
          : oauthReady
            ? '—  not connected'
            : '—  unavailable on this server'
      }`,
    ];

    if (oneNote.connected && oneNote.profileName && oneNote.source === 'user_oauth') {
      lines.push('', `Connected as: ${oneNote.profileName}`);
    }

    if (!oneNote.connected) {
      lines.push('', '_Your entries are still safe locally even without cloud sync._');
    }

    if (!oauthReady) {
      lines.push('', '_Microsoft OAuth is not configured on this server yet._');
    }

    const buttons: InlineKeyboardButton[][] = [];

    if (oauthReady) {
      buttons.push([
        {
          text:
            oneNote.connected && oneNote.source === 'user_oauth'
              ? 'Reconnect OneNote'
              : 'Connect OneNote',
          url: buildMicrosoftAuthUrlForUser(userRow.id),
        },
      ]);
    }

    if (oneNote.connected) {
      buttons.push([{ text: 'Test connection', callback_data: 'storage_test' }]);
    }

    if (oneNote.source === 'user_oauth') {
      buttons.push([{ text: 'Disconnect OneNote', callback_data: 'storage_disconnect' }]);
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
    });
  });

  bot.command('health', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;

    const users = listOnboardedUsers();
    const me = loadBotUser(userRow.telegram_id);

    const lines = [
      '❤️ *i-Journal health*',
      '',
      `• Active users: ${users.length}`,
      `• Your profile: ${me ? '✅' : '—'}`,
      `• OneNote: ${getOneNoteStatusForUser(userRow).connected ? '✅' : '—'}`,
      `• DB: ✅`,
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('testtrigger', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (userRow.is_owner !== 1) {
      await ctx.reply('Test trigger is owner-only.');
      return;
    }

    const telegramId = userRow.telegram_id;
    const text = (ctx.message as { text?: string })?.text || '';
    const arg = text.split(/\s+/)[1]?.toLowerCase();

    if (!arg || !['morning', 'evening'].includes(arg)) {
      await ctx.reply('Usage: /testtrigger morning or /testtrigger evening');
      return;
    }

    if (sessionStore.has(telegramId)) {
      await ctx.reply('You have an active session. /skip it first.');
      return;
    }

    await ctx.reply(`🧪 Triggering ${arg} session...`);

    if (arg === 'morning') {
      await startMorningSession(ctx, telegramId);
    } else {
      await startEveningSession(ctx, telegramId);
    }
  });
}
