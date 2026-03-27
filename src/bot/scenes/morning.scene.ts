import { Context } from 'telegraf';
import { sendMessage } from '../../ai';
import { buildMorningPrompt } from '../../ai/prompts/morning';
import { formatDateForJournal } from '../../ai/prompts/dayConfig';
import { sessionStore, updateJournalState, getTodayDateString } from '../../state/session.store';
import { writeMorningToOneNote } from '../../onenote/writer';
import { ConversationState } from '../../types';

const MORNING_MARKER = '## ☀️ Morning';

export async function startMorningSession(ctx: Context, userId: string): Promise<void> {
  const now = new Date();
  const systemPrompt = buildMorningPrompt(now);

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

export async function handleMorningMessage(ctx: Context, userId: string, text: string): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'morning') return;

  const systemPrompt = buildMorningPrompt(state.startedAt);

  state.conversationHistory.push({ role: 'user', content: text });

  try {
    const response = await sendMessage(systemPrompt, state.conversationHistory.slice(0, -1), text);
    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(userId, state);

    const markerIndex = response.indexOf(MORNING_MARKER);

    if (markerIndex !== -1) {
      // Session complete — split into user message and compiled entry
      const userMessage = response.substring(0, markerIndex).trim();
      const compiledEntry = response.substring(markerIndex).trim();

      if (userMessage) {
        await ctx.reply(userMessage);
      }

      // Save to OneNote
      const { dateStr, dayStr } = formatDateForJournal(state.startedAt);
      try {
        await writeMorningToOneNote(dateStr, dayStr, compiledEntry);
        await ctx.reply('☀️ Morning saved to OneNote ✓');
      } catch (oneNoteError) {
        console.error('[Morning] OneNote save failed:', oneNoteError);
        await ctx.reply('⚠️ Morning compiled but couldn\'t save to OneNote.');
      }

      state.completed = true;
      sessionStore.clear(userId);
      updateJournalState({ lastMorningDate: getTodayDateString() });
      console.log('[Morning] Session completed for', userId);
    } else {
      await ctx.reply(response);
    }
  } catch (error) {
    console.error('[Morning] Error processing message:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
