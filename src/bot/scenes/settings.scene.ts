import { Context } from 'telegraf';
import { sendMessage } from '../../ai';
import { sessionStore } from '../../state/session.store';
import { getProfile, saveProfile, Profile } from '../../profile';
import { ConversationState } from '../../types';

const UPDATE_MARKER = '[PROFILE_UPDATED]';

function buildSettingsPrompt(profile: Profile): string {
  const currentSections = profile.sections
    .map((s) => `${s.emoji} ${s.title} (key: ${s.key})`)
    .join('\n');

  const scheduleSummary = Object.entries(profile.schedule)
    .map(([day, sched]) => {
      const extras = sched.extraSections.length
        ? ` + ${sched.extraSections.map((s) => s.title).join(', ')}`
        : '';
      return `${day}: ${sched.tone}${extras}`;
    })
    .join('\n');

  return `You are helping ${profile.name} update their i-Journal settings.

Current daily sections:
${currentSections}

Current weekly schedule:
${scheduleSummary}

Morning time: ${profile.morningTime} | Evening time: ${profile.eveningTime}

Help them make changes. They might want to:
- Rename, add, or remove daily sections
- Adjust day-specific tones or contexts
- Add/remove special weekly events
- Change morning/evening times

Keep responses brief (1-2 sentences). Ask clarifying questions if needed.

When done with changes, output ${UPDATE_MARKER} followed by the complete updated profile as a JSON code block:

${UPDATE_MARKER}
\`\`\`json
{
  "name": "${profile.name}",
  "sections": [...],
  "schedule": { "Monday": {...}, ... },
  "morningTime": "${profile.morningTime}",
  "eveningTime": "${profile.eveningTime}"
}
\`\`\`

Preserve all existing fields the user didn't ask to change. Use the same JSON structure as the current profile.`;
}

function extractUpdatedProfile(response: string, current: Profile): Profile | null {
  const markerIndex = response.indexOf(UPDATE_MARKER);
  if (markerIndex === -1) return null;

  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]);

    return {
      name: parsed.name || current.name,
      sections: parsed.sections || current.sections,
      schedule: parsed.schedule || current.schedule,
      morningTime: parsed.morningTime || current.morningTime,
      eveningTime: parsed.eveningTime || current.eveningTime,
      onboardingComplete: true,
      createdAt: current.createdAt,
      lastReviewDate: new Date().toISOString().split('T')[0],
    };
  } catch (err) {
    console.error('[Settings] Failed to parse profile JSON:', err);
    return null;
  }
}

export async function startSettings(ctx: Context, userId: string): Promise<void> {
  const profile = getProfile();

  const state: ConversationState = {
    userId,
    sessionType: 'settings',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(),
    completed: false,
  };

  sessionStore.set(userId, state);

  try {
    const systemPrompt = buildSettingsPrompt(profile);
    const greeting = await sendMessage(systemPrompt, [], 'I want to adjust my journal settings.');
    state.conversationHistory.push(
      { role: 'user', content: 'I want to adjust my journal settings.' },
      { role: 'assistant', content: greeting }
    );
    sessionStore.set(userId, state);
    await ctx.reply(greeting);
  } catch (error) {
    console.error('[Settings] Failed to start:', error);
    sessionStore.clear(userId);
    await ctx.reply('Sorry, I had trouble opening settings. Try /settings again.');
  }
}

export async function handleSettingsMessage(ctx: Context, userId: string, text: string): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'settings') return;

  const profile = getProfile();
  const systemPrompt = buildSettingsPrompt(profile);
  state.conversationHistory.push({ role: 'user', content: text });

  try {
    const response = await sendMessage(systemPrompt, state.conversationHistory.slice(0, -1), text);
    state.conversationHistory.push({ role: 'assistant', content: response });
    sessionStore.set(userId, state);

    const updated = extractUpdatedProfile(response, profile);

    if (updated) {
      const userMessage = response.substring(0, response.indexOf(UPDATE_MARKER)).trim();
      if (userMessage) {
        await ctx.reply(userMessage);
      }

      saveProfile(updated);

      const sectionList = updated.sections.map((s) => `  ${s.emoji} ${s.title}`).join('\n');
      await ctx.reply(
        `✅ *Settings updated!*\n\n` +
          `*Daily sections:*\n${sectionList}\n\n` +
          `Changes take effect on your next session.`,
        { parse_mode: 'Markdown' }
      );

      state.completed = true;
      sessionStore.clear(userId);
      console.log('[Settings] Updated for', userId);
    } else {
      await ctx.reply(response);
    }
  } catch (error) {
    console.error('[Settings] Error:', error);
    await ctx.reply('Sorry, I had a brief hiccup. Could you say that again?');
  }
}
