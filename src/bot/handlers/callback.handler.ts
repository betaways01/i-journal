import { Context, Telegraf } from 'telegraf';
import { sessionStore } from '../../state/session.store';
import { startMorningSession } from '../scenes/morning.scene';
import { startEveningSession } from '../scenes/evening.scene';
import { registerUserFromContext } from '../userContext';
import {
  disconnectStoredOneNoteForUser,
  testOneNoteConnectionForUser,
} from '../../onenote/writer';

const REMIND_LATER_MINUTES = 30;

export function registerCallbacks(bot: Telegraf): void {
  bot.on('callback_query', async (ctx) => {
    const userRow = registerUserFromContext(ctx);
    if (!userRow) return;

    const data = (ctx.callbackQuery as { data?: string }).data;
    if (!data) return;

    const telegramId = userRow.telegram_id;

    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore — callback may have already been answered
    }

    switch (data) {
      case 'start_morning': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        await startMorningSession(ctx as unknown as Context, telegramId);
        return;
      }
      case 'start_evening': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        await startEveningSession(ctx as unknown as Context, telegramId);
        return;
      }
      case 'catchup_yesterday': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        await ctx.reply("📝 Catching up on yesterday — I'll save this under yesterday's date.");
        await startEveningSession(ctx as unknown as Context, telegramId, yesterdayDate);
        return;
      }
      case 'remind_later': {
        await ctx.reply(`No problem — I'll check in again in ${REMIND_LATER_MINUTES} minutes.`);
        setTimeout(() => {
          sendEveningPrompt(bot, telegramId, { missedYesterday: false }).catch((e) =>
            console.error('[Callback] remind_later resend failed:', e)
          );
        }, REMIND_LATER_MINUTES * 60 * 1000);
        return;
      }
      case 'skip_today': {
        sessionStore.clear(telegramId);
        await ctx.reply('Skipped. Rest well — tomorrow is a new day. 🌙');
        return;
      }
      case 'storage_disconnect': {
        const result = disconnectStoredOneNoteForUser(userRow);
        if (result.disconnected) {
          if (result.nowUsingLegacyFallback) {
            await ctx.reply(
              'Stored OneNote tokens removed. This account is still using the legacy server-level OneNote connection.'
            );
            return;
          }

          await ctx.reply('OneNote disconnected. Your entries will keep saving locally.');
          return;
        }

        if (result.nowUsingLegacyFallback) {
          await ctx.reply(
            'This connection comes from the server env, so there is nothing stored to disconnect here yet.'
          );
          return;
        }

        await ctx.reply('No stored OneNote connection found for this account.');
        return;
      }
      case 'storage_test': {
        try {
          const profile = await testOneNoteConnectionForUser(userRow);
          await ctx.reply(
            `OneNote looks good.\n\nConnected as ${profile.displayName}${profile.email ? `\n${profile.email}` : ''}`
          );
        } catch (error) {
          console.error('[Callback] storage_test failed:', error);
          await ctx.reply('I could not reach OneNote right now. Try reconnecting from /storage.');
        }
        return;
      }
    }
  });
}

export async function sendMorningPrompt(bot: Telegraf, telegramId: string, name: string): Promise<void> {
  await bot.telegram.sendMessage(telegramId, `Morning, ${name}. Ready for your check-in?`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '☀️ Start', callback_data: 'start_morning' },
          { text: '⏰ Remind later', callback_data: 'remind_later' },
        ],
        [{ text: '⏭️ Skip today', callback_data: 'skip_today' }],
      ],
    },
  });
}

export async function sendEveningPrompt(
  bot: Telegraf,
  telegramId: string,
  opts: { name?: string; missedYesterday: boolean; missedDayName?: string } = { missedYesterday: false }
): Promise<void> {
  const greeting = opts.missedYesterday
    ? `Evening, ${opts.name ?? 'friend'}. We missed ${opts.missedDayName ?? 'yesterday'}'s journal. No pressure — your call.`
    : `Evening, ${opts.name ?? 'friend'}. Ready for your journal?`;

  const keyboard = opts.missedYesterday
    ? [
        [
          { text: '📖 Journal today', callback_data: 'start_evening' },
          { text: '📝 Catch up yesterday', callback_data: 'catchup_yesterday' },
        ],
        [
          { text: '⏰ Remind later', callback_data: 'remind_later' },
          { text: '⏭️ Skip today', callback_data: 'skip_today' },
        ],
      ]
    : [
        [
          { text: '📖 Start journal', callback_data: 'start_evening' },
          { text: '⏰ Remind later', callback_data: 'remind_later' },
        ],
        [{ text: '⏭️ Skip today', callback_data: 'skip_today' }],
      ];

  await bot.telegram.sendMessage(telegramId, greeting, {
    reply_markup: { inline_keyboard: keyboard },
  });
}
