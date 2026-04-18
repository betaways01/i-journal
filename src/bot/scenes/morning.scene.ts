import { Context } from 'telegraf';
import { sendMessage } from '../../ai';
import { buildMorningPrompt } from '../../ai/prompts/morning';
import { formatDateForJournal } from '../../ai/prompts/dayConfig';
import { sessionStore, updateJournalState } from '../../state/session.store';
import { ConversationState } from '../../types';
import { loadBotUser } from '../userContext';
import { saveJournalEntry, markEntrySavedToCloud } from '../../db/entries.repo';
import {
  getOneNoteStatusForUser,
  writeMorningToOneNoteForUser,
} from '../../onenote/writer';

const MORNING_MARKER = '## ☀️ Morning';

export async function startMorningSession(ctx: Context, userId: string): Promise<void> {
  const botUser = loadBotUser(userId);
  if (!botUser) {
    await ctx.reply('Let\'s set up your journal first — use /start.');
    return;
  }

  const now = new Date();
  const systemPrompt = buildMorningPrompt(botUser.profile, now);

  const state: ConversationState = {
    userId,
    sessionType: 'morning',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: now,
    completed: false,
  };

  sessionStore.set(userId, state);

  try {
    const greeting = await sendMessage(systemPrompt, [], 'Begin the morning check-in.');
    state.conversationHistory.push(
      { role: 'user', content: 'Begin the morning check-in.' },
      { role: 'assistant', content: greeting }
    );
    sessionStore.set(userId, state);
    await ctx.reply(greeting);
  } catch (error) {
    console.error('[Morning] Failed to start session:', error);
    sessionStore.clear(userId);
    await ctx.reply('Sorry, I had trouble starting the morning session. Try again with /morning.');
  }
}

export async function handleMorningMessage(
  ctx: Context,
  userId: string,
  text: string
): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'morning') return;

  const botUser = loadBotUser(userId);
  if (!botUser) return;

  const systemPrompt = buildMorningPrompt(botUser.profile, state.startedAt);

  state.conversationHistory.push({ role: 'user', content: text });

  try {
    const response = await sendMessage(systemPrompt, state.conversationHistory.slice(0, -1), text);
    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(userId, state);

    const markerIndex = response.indexOf(MORNING_MARKER);

    if (markerIndex !== -1) {
      const userMessage = response.substring(0, markerIndex).trim();
      const compiledEntry = response.substring(markerIndex).trim();

      if (userMessage) {
        await ctx.reply(userMessage);
      }

      const { dateStr, dayStr } = formatDateForJournal(state.startedAt, botUser.profile.timezone);

      // Local save first
      const entryId = saveJournalEntry({
        userId: botUser.row.id,
        entryDate: dateStr,
        dayOfWeek: dayStr,
        sessionType: 'morning',
        contentMarkdown: compiledEntry,
      });

      if (getOneNoteStatusForUser(botUser.row).connected) {
        try {
          const webUrl = await writeMorningToOneNoteForUser(
            botUser.row,
            dateStr,
            dayStr,
            compiledEntry
          );
          markEntrySavedToCloud(entryId, webUrl);
          await ctx.reply('☀️ Saved ✓');
        } catch (oneNoteError) {
          console.error('[Morning] OneNote save failed:', oneNoteError);
          await ctx.reply('☀️ Saved locally ✓ (cloud sync failed)');
        }
      } else {
        await ctx.reply('☀️ Saved ✓');
      }

      state.completed = true;
      sessionStore.clear(userId);
      updateJournalState(userId, { lastMorningDate: dateStr });
      console.log('[Morning] Session completed for', userId);
    } else {
      await ctx.reply(response);
    }
  } catch (error) {
    console.error('[Morning] Error processing message:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
