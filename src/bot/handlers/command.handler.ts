import { Context, Telegraf } from 'telegraf';
import { config } from '../../config';
import { getProfile, profileExists, needsReview } from '../../profile';
import { sessionStore, getJournalState, getTodayDateString } from '../../state/session.store';
import { startMorningSession } from '../scenes/morning.scene';
import { startEveningSession } from '../scenes/evening.scene';
import { startOnboarding, skipOnboarding } from '../scenes/onboarding.scene';
import { startSettings } from '../scenes/settings.scene';

function isOwner(ctx: Context): boolean {
  return String(ctx.from?.id) === config.telegram.ownerId;
}

function requiresOnboarding(): boolean {
  const profile = getProfile();
  return !profileExists() || !profile.onboardingComplete;
}

export function registerCommands(bot: Telegraf): void {
  bot.command('start', async (ctx) => {
    if (!isOwner(ctx)) return;

    const userId = String(ctx.from!.id);

    if (requiresOnboarding()) {
      await ctx.reply(
        '🌅 *Welcome to i-Journal!*\n\n' +
          'Let me set up your personal journal. I\'ll ask a few quick questions to customize it for you.\n\n' +
          '_Use /skip anytime to use defaults instead._',
        { parse_mode: 'Markdown' }
      );
      await startOnboarding(ctx, userId);
      return;
    }

    const profile = getProfile();
    await ctx.reply(
      `🌅 *Welcome back, ${profile.name}!*\n\n` +
        `☀️ /morning — Start your morning check-in\n` +
        `📖 /journal — Start your evening journal\n` +
        `⚙️ /settings — Adjust your sections or schedule\n` +
        `⏭️ /skip — Skip current session\n` +
        `📊 /status — Check today's session status\n` +
        `📄 /last — Show your last journal entry\n` +
        `🧪 /testtrigger — Test the scheduler\n\n` +
        `I'll reach out at *${profile.morningTime}* and *${profile.eveningTime}* each day.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('morning', async (ctx) => {
    if (!isOwner(ctx)) return;

    const userId = String(ctx.from!.id);

    if (requiresOnboarding()) {
      await ctx.reply('Let\'s set up your journal first! Use /start to begin.');
      return;
    }

    if (sessionStore.has(userId)) {
      ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }

    await startMorningSession(ctx, userId);
  });

  bot.command('journal', async (ctx) => {
    if (!isOwner(ctx)) return;

    const userId = String(ctx.from!.id);

    if (requiresOnboarding()) {
      await ctx.reply('Let\'s set up your journal first! Use /start to begin.');
      return;
    }

    if (sessionStore.has(userId)) {
      ctx.reply('You already have an active session. Finish it first, or /skip to start fresh.');
      return;
    }

    // Check for seasonal review prompt
    if (needsReview()) {
      await ctx.reply(
        '💡 You\'ve been journaling for a while! Your sections or schedule might need a refresh. ' +
          'Type /settings anytime to adjust.',
      );
    }

    await startEveningSession(ctx, userId);
  });

  bot.command('settings', async (ctx) => {
    if (!isOwner(ctx)) return;

    const userId = String(ctx.from!.id);

    if (requiresOnboarding()) {
      await ctx.reply('Let\'s set up your journal first! Use /start to begin.');
      return;
    }

    if (sessionStore.has(userId)) {
      ctx.reply('You have an active session. Finish or /skip it first.');
      return;
    }

    await startSettings(ctx, userId);
  });

  bot.command('skip', (ctx) => {
    if (!isOwner(ctx)) return;

    const userId = String(ctx.from!.id);
    if (sessionStore.has(userId)) {
      const session = sessionStore.get(userId);

      // If skipping onboarding, save defaults
      if (session?.sessionType === 'onboarding') {
        skipOnboarding(userId);
        ctx.reply('Setup skipped — using defaults. You can customize anytime with /settings. 🙂');
        return;
      }

      sessionStore.clear(userId);
      ctx.reply('Session skipped. Rest well. Tomorrow is a new day. 🌙');
    } else {
      ctx.reply('No active session to skip.');
    }
  });

  bot.command('status', (ctx) => {
    if (!isOwner(ctx)) return;

    const state = getJournalState();
    const today = getTodayDateString();
    const profile = getProfile();

    const morningDone = state.lastMorningDate === today;
    const eveningDone = state.lastEveningDate === today;

    const userId = String(ctx.from!.id);
    const activeSession = sessionStore.get(userId);

    let status = `📊 *Journal Status — ${today}*\n\n`;
    status += `☀️ Morning: ${morningDone ? '✅ Done' : '⏳ Pending'}\n`;
    status += `🌙 Evening: ${eveningDone ? '✅ Done' : '⏳ Pending'}\n`;

    if (activeSession) {
      status += `\n🔄 Active session: ${activeSession.sessionType}`;
    }

    status += `\n\n📋 Sections: ${profile.sections.map((s) => s.emoji).join(' ')}`;

    ctx.reply(status, { parse_mode: 'Markdown' });
  });

  bot.command('last', (ctx) => {
    if (!isOwner(ctx)) return;

    ctx.reply(
      'Your journal entries are saved in OneNote under the *i-Journal* notebook → *Daily Entries* section.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('testtrigger', async (ctx) => {
    if (!isOwner(ctx)) return;

    const userId = String(ctx.from!.id);
    const text = (ctx.message as { text?: string })?.text || '';
    const arg = text.split(/\s+/)[1]?.toLowerCase();

    if (!arg || !['morning', 'evening'].includes(arg)) {
      await ctx.reply('Usage: /testtrigger morning or /testtrigger evening');
      return;
    }

    if (sessionStore.has(userId)) {
      await ctx.reply('You have an active session. /skip it first.');
      return;
    }

    await ctx.reply(`🧪 Triggering ${arg} session...`);

    if (arg === 'morning') {
      await startMorningSession(ctx, userId);
    } else {
      await startEveningSession(ctx, userId);
    }
  });
}
