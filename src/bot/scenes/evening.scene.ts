import { Context } from 'telegraf';
import { sendMessage } from '../../ai';
import { buildEveningPrompt } from '../../ai/prompts/evening';
import { formatDateForJournal } from '../../ai/prompts/dayConfig';
import { sessionStore, updateJournalState, getTodayDateString } from '../../state/session.store';
import { writeEveningToOneNote } from '../../onenote/writer';
import { ConversationState } from '../../types';

const EVENING_MARKER = '## 🌙 Evening';

export async function startEveningSession(ctx: Context, userId: string): Promise<void> {
  const now = new Date();
  const systemPrompt = buildEveningPrompt(now);

  const state: ConversationState = {
    userId,
    sessionType: 'evening',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: now,
    completed: false,
  };

  sessionStore.set(userId, state);

  try {
    const greeting = await sendMessage(systemPrompt, [], 'Begin the evening journal session.');
    state.conversationHistory.push(
      { role: 'user', content: 'Begin the evening journal session.' },
      { role: 'assistant', content: greeting }
    );
    sessionStore.set(userId, state);
    await ctx.reply(greeting);
  } catch (error) {
    console.error('[Evening] Failed to start session:', error);
    sessionStore.clear(userId);
    await ctx.reply('Sorry, I had trouble starting the evening session. Try again with /journal.');
  }
}

export async function handleEveningMessage(ctx: Context, userId: string, text: string): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'evening') return;

  const systemPrompt = buildEveningPrompt(state.startedAt);

  state.conversationHistory.push({ role: 'user', content: text });

  try {
    const response = await sendMessage(systemPrompt, state.conversationHistory.slice(0, -1), text);
    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(userId, state);

    const isCompiledEntry = response.includes(EVENING_MARKER) && response.includes('###') && response.includes('---');

    if (isCompiledEntry) {
      state.completed = true;
      sessionStore.clear(userId);
      updateJournalState({ lastEveningDate: getTodayDateString() });

      await ctx.reply(response);

      // Save to OneNote
      const { dateStr, dayStr } = formatDateForJournal(state.startedAt);
      try {
        console.log('[Evening] Saving to OneNote...');
        const pageUrl = await writeEveningToOneNote(dateStr, dayStr, response);
        const msg = pageUrl
          ? `🌙 Saved to OneNote ✓\n[Open in OneNote](${pageUrl})`
          : '🌙 Saved to OneNote ✓';
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      } catch (oneNoteError) {
        console.error('[Evening] Failed to save to OneNote:', oneNoteError);
        await ctx.reply(
          '⚠️ Journal entry compiled but I couldn\'t save to OneNote. The entry is in your chat above — you can copy it manually.'
        );
      }

      console.log('[Evening] Session completed for', userId);
    } else {
      await ctx.reply(response);
    }
  } catch (error) {
    console.error('[Evening] Error processing message:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
