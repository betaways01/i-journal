import { Context, Telegraf } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/types';
import { listOnboardedUsers, markOnboardingIncomplete, UserRow } from '../../db/users.repo';
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
import { startCompanionSession } from '../scenes/companion.scene';
import { startAutomationCapture } from '../scenes/automation.scene';
import { registerUserFromContext, loadBotUser } from '../userContext';
import { hasMicrosoftOAuthConfigured } from '../../config';
import { buildMicrosoftAuthUrlForUser } from '../../onenote/auth';
import { getOneNoteStatusForUser } from '../../onenote/writer';
import { QUICK_ACTIONS, STATUS_ACTIONS } from '../keyboards';

async function ensureOnboardedOrGuide(
  ctx: Context,
  userRow: UserRow,
  actionName: string
): Promise<boolean> {
  if (userRow.onboarding_complete === 1) return true;

  await ctx.reply(
    actionName === 'start'
      ? "Hey. I'm your journal companion.\n\nLet's set up the basics so I can remember you properly. You can use /skip anytime if you'd rather start with defaults."
      : "Let's get acquainted first — use /start."
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
        "Hey. I'm your journal companion.\n\nLet's set up the basics so I can remember you properly. /skip anytime if you'd rather use defaults."
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
      `Hey, ${profile.name}. Good to see you.\n\n` +
        `Just message me anytime — I'll pick it up.\n\n` +
        `Want to change anything? Use /settings for the reliable control panel.\n\n` +
        `You can also ask for automations, like: *"remind me in 20 minutes to call Alex"* or *"send motivation every morning."*\n\n` +
        `I'll also check in around *${profile.morningTime}* and *${profile.eveningTime}*.`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: QUICK_ACTIONS },
      }
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

  bot.command('drop', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'drop'))) return;

    const telegramId = userRow.telegram_id;
    if (sessionStore.has(telegramId)) {
      await ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }
    await startCompanionSession(ctx, telegramId, { mode: 'drop' });
  });

  bot.command('vent', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'vent'))) return;

    const telegramId = userRow.telegram_id;
    if (sessionStore.has(telegramId)) {
      await ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }
    await startCompanionSession(ctx, telegramId, { mode: 'vent' });
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

  bot.command('automate', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    if (!(await ensureOnboardedOrGuide(ctx, userRow, 'automate'))) return;

    const telegramId = userRow.telegram_id;
    if (sessionStore.has(telegramId)) {
      await ctx.reply('You have an active session. Finish or /skip it first.');
      return;
    }
    await startAutomationCapture(ctx, telegramId);
  });

  bot.command('skip', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;
    const telegramId = userRow.telegram_id;

    if (sessionStore.has(telegramId)) {
      const session = sessionStore.get(telegramId);

      if (session?.sessionType === 'onboarding') {
        skipOnboarding(telegramId);
        await ctx.reply('Setup skipped — using defaults. Customize anytime with /settings.');
        return;
      }

      if (session?.sessionType === 'settings') {
        sessionStore.clear(telegramId);
        await ctx.reply('Settings closed.');
        return;
      }

      if (session?.sessionType === 'routine_setup' || session?.sessionType === 'automation_setup') {
        sessionStore.clear(telegramId);
        await ctx.reply('Automation setup canceled.');
        return;
      }

      sessionStore.clear(telegramId);
      await ctx.reply('Session skipped. Rest well. Tomorrow is a new day. 🌙');
    } else {
      await ctx.reply('No active session to skip.');
    }
  });

  bot.command('resetsetup', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;

    const telegramId = userRow.telegram_id;
    sessionStore.clear(telegramId);
    markOnboardingIncomplete(userRow.id);

    await ctx.reply(
      'Fresh setup started. I will keep your existing journal entries, but rebuild how I understand you.'
    );
    await startOnboarding(ctx, telegramId);
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

    if (botUser.profile.sections.length > 0) {
      status += `\n\n📋 Sections: ${botUser.profile.sections.map((s) => s.emoji).join(' ')}`;
    }

    await ctx.reply(status, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: STATUS_ACTIONS({ morningDone, eveningDone }) },
    });
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
    const isDrop = entry.session_type.startsWith('drop');
    const cloudNote = entry.onenote_url
      ? `\n\n[Open in OneNote](${entry.onenote_url})`
      : entry.saved_to_cloud === 0 && getOneNoteStatusForUser(userRow).connected
        ? isDrop
          ? '\n\n_(drop entries save locally for now)_'
          : '\n\n_(not yet synced to OneNote)_'
        : '';
    await ctx.reply(header + body + cloudNote, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📝 Drop', callback_data: 'drop_now' }, { text: '📖 Journal', callback_data: 'journal_now' }]] },
    });
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

    if (oauthReady && !oneNote.connected) {
      lines.push(
        '',
        '👉 When you connect, sign in with the Microsoft account whose OneNote you actually use. I check the connection right away — if it cannot reach OneNote, I will tell you, and your entries stay safe locally regardless.'
      );
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

    const me = loadBotUser(userRow.telegram_id);

    const lines = [
      '❤️ *i-Journal health*',
      '',
      `• Your profile: ${me ? '✅' : '—'}`,
      `• OneNote: ${getOneNoteStatusForUser(userRow).connected ? '✅' : '—'}`,
      `• DB: ✅`,
    ];

    if (userRow.is_owner === 1) {
      const users = listOnboardedUsers();
      lines.push(`• Active users (owner): ${users.length}`);
    }

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
