import { Context } from 'telegraf';
import { sendMessage } from '../../ai';
import { sessionStore } from '../../state/session.store';
import { getDefaultProfile, saveProfile, Profile } from '../../profile';
import { ConversationState } from '../../types';

const PROFILE_MARKER = '[PROFILE_COMPLETE]';

function buildOnboardingPrompt(): string {
  return `You are setting up i-Journal, a daily journaling bot. Your job is to learn about this person and configure their journal.

Keep every response to 1-2 sentences + one question. Be warm but efficient. 3-4 exchanges total.

Ask about (one topic per exchange):
1. Their name
2. What life areas they want to reflect on daily. Suggest common ones: Work, Family, Faith/Spirituality, Personal Growth, Health, Creativity, Relationships, Learning. They can pick, rename, or add their own.
3. Any special weekly rhythms — fasting days, classes, meetings, church, rest days, etc.

When you have enough info, output ${PROFILE_MARKER} followed by a JSON code block with the complete profile:

${PROFILE_MARKER}
\`\`\`json
{
  "name": "Their Name",
  "sections": [
    { "key": "short_key", "emoji": "relevant_emoji", "title": "Display Title" }
  ],
  "schedule": {
    "Monday": { "tone": "descriptive tone", "extraSections": [], "context": "what's special about this day", "closingStyle": "style for closing line" },
    "Tuesday": { "tone": "Regular, balanced", "extraSections": [], "context": "Standard journal day.", "closingStyle": "A simple, encouraging closing line." },
    "Wednesday": { ... },
    "Thursday": { ... },
    "Friday": { ... },
    "Saturday": { ... },
    "Sunday": { ... }
  }
}
\`\`\`

Rules for the profile JSON:
- Choose appropriate emojis for each section
- Use lowercase_snake_case for keys
- For days without special events use: { "tone": "Regular, balanced", "extraSections": [], "context": "Standard journal day.", "closingStyle": "A simple, encouraging closing line." }
- extraSections on special days should have their own emoji and title
- Tones should feel natural and match the day's energy`;
}

function extractProfile(response: string): Profile | null {
  const markerIndex = response.indexOf(PROFILE_MARKER);
  if (markerIndex === -1) return null;

  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const defaults = getDefaultProfile();

    return {
      name: parsed.name || defaults.name,
      sections: parsed.sections || defaults.sections,
      schedule: parsed.schedule || defaults.schedule,
      morningTime: defaults.morningTime,
      eveningTime: defaults.eveningTime,
      onboardingComplete: true,
      createdAt: new Date().toISOString().split('T')[0],
      lastReviewDate: new Date().toISOString().split('T')[0],
    };
  } catch (err) {
    console.error('[Onboarding] Failed to parse profile JSON:', err);
    return null;
  }
}

export async function startOnboarding(ctx: Context, userId: string): Promise<void> {
  const state: ConversationState = {
    userId,
    sessionType: 'onboarding',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(),
    completed: false,
  };

  sessionStore.set(userId, state);

  try {
    const systemPrompt = buildOnboardingPrompt();
    const greeting = await sendMessage(systemPrompt, [], 'Start the onboarding.');
    state.conversationHistory.push(
      { role: 'user', content: 'Start the onboarding.' },
      { role: 'assistant', content: greeting }
    );
    sessionStore.set(userId, state);
    await ctx.reply(greeting);
  } catch (error) {
    console.error('[Onboarding] Failed to start:', error);
    sessionStore.clear(userId);
    await ctx.reply('Sorry, I had trouble starting setup. Try /start again.');
  }
}

export async function handleOnboardingMessage(ctx: Context, userId: string, text: string): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'onboarding') return;

  const systemPrompt = buildOnboardingPrompt();
  state.conversationHistory.push({ role: 'user', content: text });

  try {
    const response = await sendMessage(systemPrompt, state.conversationHistory.slice(0, -1), text);
    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(userId, state);

    const profile = extractProfile(response);

    if (profile) {
      // Strip the JSON block from the user-facing message
      const userMessage = response.substring(0, response.indexOf(PROFILE_MARKER)).trim();
      if (userMessage) {
        await ctx.reply(userMessage);
      }

      saveProfile(profile);

      const sectionList = profile.sections.map((s) => `  ${s.emoji} ${s.title}`).join('\n');
      await ctx.reply(
        `✅ *Journal set up!* Here's your profile, ${profile.name}:\n\n` +
          `*Daily sections:*\n${sectionList}\n\n` +
          `Use /journal to start your first evening session, or I'll reach out at ${profile.morningTime} and ${profile.eveningTime}.\n\n` +
          `You can adjust anything anytime with /settings.`,
        { parse_mode: 'Markdown' }
      );

      state.completed = true;
      sessionStore.clear(userId);
      console.log('[Onboarding] Completed for', userId);
    } else {
      await ctx.reply(response);
    }
  } catch (error) {
    console.error('[Onboarding] Error:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}

export function skipOnboarding(userId: string): void {
  const defaults = getDefaultProfile();
  defaults.onboardingComplete = true;
  defaults.createdAt = new Date().toISOString().split('T')[0];
  defaults.lastReviewDate = new Date().toISOString().split('T')[0];
  saveProfile(defaults);
  sessionStore.clear(userId);
  console.log('[Onboarding] Skipped, default profile saved for', userId);
}
