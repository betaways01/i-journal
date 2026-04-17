import { Context } from 'telegraf';
import { sendMessage } from '../../ai';
import { buildEveningPrompt } from '../../ai/prompts/evening';
import { formatDateForJournal } from '../../ai/prompts/dayConfig';
import { sessionStore, updateJournalState } from '../../state/session.store';
import { writeEveningToOneNote } from '../../onenote/writer';
import { ConversationState } from '../../types';
import { loadBotUser } from '../userContext';
import { saveJournalEntry, markEntrySavedToCloud } from '../../db/entries.repo';
import { hasOwnerOneNoteConfigured } from '../../config';

const EVENING_MARKER = '## 🌙 Evening';

export async function startEveningSession(
  ctx: Context,
  userId: string,
  targetDate?: Date
): Promise<void> {
  const botUser = loadBotUser(userId);
  if (!botUser) {
    await ctx.reply('Let\'s set up your journal first — use /start.');
    return;
  }

  const sessionDate = targetDate ?? new Date();
  const systemPrompt = buildEveningPrompt(botUser.profile, sessionDate);

  const state: ConversationState = {
    userId,
    sessionType: 'evening',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: sessionDate,
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

export async function handleEveningMessage(
  ctx: Context,
  userId: string,
  text: string
): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'evening') return;

  const botUser = loadBotUser(userId);
  if (!botUser) return;

  const systemPrompt = buildEveningPrompt(botUser.profile, state.startedAt);

  state.conversationHistory.push({ role: 'user', content: text });

  try {
    const response = await sendMessage(systemPrompt, state.conversationHistory.slice(0, -1), text);
    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(userId, state);

    const isCompiledEntry =
      response.includes(EVENING_MARKER) && response.includes('###') && response.includes('---');

    if (isCompiledEntry) {
      state.completed = true;
      sessionStore.clear(userId);

      const { dateStr, dayStr } = formatDateForJournal(state.startedAt, botUser.profile.timezone);
      updateJournalState(userId, { lastEveningDate: dateStr });

      // Local save FIRST — source of truth
      const entryId = saveJournalEntry({
        userId: botUser.row.id,
        entryDate: dateStr,
        dayOfWeek: dayStr,
        sessionType: 'evening',
        contentMarkdown: response,
      });

      await ctx.reply(response);

      // Cloud save is best-effort (only if the owner has OneNote configured)
      if (botUser.isOwner && hasOwnerOneNoteConfigured()) {
        try {
          console.log('[Evening] Saving to OneNote...');
          const pageUrl = await writeEveningToOneNote(dateStr, dayStr, response);
          markEntrySavedToCloud(entryId, pageUrl);
          const msg = pageUrl
            ? `🌙 Saved ✓\n[Open in OneNote](${pageUrl})`
            : '🌙 Saved ✓';
          await ctx.reply(msg, { parse_mode: 'Markdown' });
        } catch (oneNoteError) {
          console.error('[Evening] OneNote save failed:', oneNoteError);
          await ctx.reply(
            '🌙 Saved locally ✓ (cloud sync to OneNote failed — your entry is safe, try again from /status later)'
          );
        }
      } else {
        await ctx.reply('🌙 Saved ✓');
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
