import { Context, Telegraf } from 'telegraf';
import { sessionStore } from '../../state/session.store';
import { startMorningSession } from '../scenes/morning.scene';
import { startEveningSession } from '../scenes/evening.scene';
import { startCompanionSession, handleCompanionMessage } from '../scenes/companion.scene';
import { startSettings } from '../scenes/settings.scene';
import { registerUserFromContext } from '../userContext';
import {
  disconnectStoredOneNoteForUser,
  testOneNoteConnectionForUser,
} from '../../onenote/writer';
import { scheduleReminder } from '../../db/reminders.repo';
import { getUserByTelegramId } from '../../db/users.repo';
import { getLastEntry } from '../../db/entries.repo';
import { getOneNoteStatusForUser } from '../../onenote/writer';
import { getJournalState, getTodayDateStringInZone } from '../../state/session.store';
import { loadBotUser } from '../userContext';
import { STATUS_ACTIONS } from '../keyboards';

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
      case 'remind_later':
      case 'remind_later_evening':
      case 'remind_later_morning': {
        const userForReminder = getUserByTelegramId(telegramId);
        if (!userForReminder) return;

        const kind =
          data === 'remind_later_morning' ? 'morning_remind_later' : 'evening_remind_later';
        const fireAt = new Date(Date.now() + REMIND_LATER_MINUTES * 60 * 1000);
        scheduleReminder({
          userId: userForReminder.id,
          kind,
          fireAt,
        });
        await ctx.reply(`No problem — I'll check in again in ${REMIND_LATER_MINUTES} minutes.`);
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
      case 'journal_now': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        await startEveningSession(ctx as unknown as Context, telegramId);
        return;
      }
      case 'drop_now': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        await startCompanionSession(ctx as unknown as Context, telegramId, { mode: 'drop' });
        return;
      }
      case 'compile_now': {
        if (!sessionStore.has(telegramId)) {
          await ctx.reply('No active session to save.');
          return;
        }
        // Nudge the AI to compile what's there as an entry now.
        await handleCompanionMessage(
          ctx as unknown as Context,
          telegramId,
          '[system] Please compile what we have into an entry now — I need to stop here.'
        );
        return;
      }
      case 'drop_continue': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        await startCompanionSession(ctx as unknown as Context, telegramId, {
          mode: 'drop',
          continuation: true,
        });
        return;
      }
      case 'vent_now': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('You already have an active session.');
          return;
        }
        await startCompanionSession(ctx as unknown as Context, telegramId, { mode: 'vent' });
        return;
      }
      case 'last_entry': {
        const entry = getLastEntry(userRow.id);
        if (!entry) {
          await ctx.reply('No entries yet — /journal or /drop to make your first.');
          return;
        }
        const header = `📄 *${entry.entry_date} (${entry.day_of_week})*\n\n`;
        const body = entry.content_markdown.length > 3500
          ? entry.content_markdown.slice(0, 3500) + '\n\n…(truncated)'
          : entry.content_markdown;
        const cloudNote = entry.onenote_url
          ? `\n\n[Open in OneNote](${entry.onenote_url})`
          : entry.saved_to_cloud === 0 && getOneNoteStatusForUser(userRow).connected
            ? '\n\n_(not yet synced to OneNote)_'
            : '';
        await ctx.reply(header + body + cloudNote, { parse_mode: 'Markdown' });
        return;
      }
      case 'status_now': {
        const botUser = loadBotUser(telegramId);
        if (!botUser) return;
        const state = getJournalState(telegramId);
        const today = getTodayDateStringInZone(botUser.profile.timezone);
        const morningDone = state.lastMorningDate === today;
        const eveningDone = state.lastEveningDate === today;
        const lines = [
          `📊 *Today — ${today}*`,
          '',
          `☀️ Morning: ${morningDone ? '✅ Done' : '⏳ Pending'}`,
          `🌙 Evening: ${eveningDone ? '✅ Done' : '⏳ Pending'}`,
        ];
        await ctx.reply(lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: STATUS_ACTIONS({ morningDone, eveningDone }) },
        });
        return;
      }
      case 'open_settings': {
        if (sessionStore.has(telegramId)) {
          await ctx.reply('Finish your active session first, or /skip it.');
          return;
        }
        await startSettings(ctx as unknown as Context, telegramId);
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
          { text: '⏰ Remind later', callback_data: 'remind_later_morning' },
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
          { text: '⏰ Remind later', callback_data: 'remind_later_evening' },
          { text: '⏭️ Skip today', callback_data: 'skip_today' },
        ],
      ]
    : [
        [
          { text: '📖 Start journal', callback_data: 'start_evening' },
          { text: '⏰ Remind later', callback_data: 'remind_later_evening' },
        ],
        [{ text: '⏭️ Skip today', callback_data: 'skip_today' }],
      ];

  await bot.telegram.sendMessage(telegramId, greeting, {
    reply_markup: { inline_keyboard: keyboard },
  });
}
