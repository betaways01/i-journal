import { Profile } from '../profile/defaults';
import { RoutineRecord, SkillRunResult } from './types';
import { sendMessage } from '../ai';

/**
 * Every routine generates its message FRESH from the user's own instruction. There is no
 * hardcoded content (no canned word list, no fixed templates) — the user can ask for any
 * recurring message and the model composes it each time. A legacy 'learning.word_of_day'
 * routine is just a custom prompt whose instruction is "teach a useful word".
 */
function instructionFor(routine: RoutineRecord): string {
  const prompt = typeof routine.config.prompt === 'string' ? routine.config.prompt.trim() : '';
  if (prompt) return prompt;
  const goal = typeof routine.config.goal === 'string' ? routine.config.goal.trim() : '';
  if (goal) return goal;
  if (routine.kind === 'learning.word_of_day') {
    return 'Teach one useful word: the word, a one-line meaning, and a natural example sentence.';
  }
  return routine.name;
}

async function runGeneratedRoutine(routine: RoutineRecord, profile: Profile): Promise<SkillRunResult> {
  const instruction = instructionFor(routine);

  const system = `You are ${profile.name}'s journal companion, running a recurring routine they set up themselves.

Write ONE short Telegram message that fulfils the routine, in your warm, human voice. Make it fresh — never the same wording twice, never a canned template. Be specific and useful. Do not claim you did anything outside this chat.

Routine: ${routine.name}
What they asked for: ${instruction}
Their life areas: ${profile.sections.map((s) => s.title).join(', ') || 'not specified'}
Timezone: ${profile.timezone}`;

  const message = await sendMessage(system, [], 'Generate this routine message now.');
  const text = message.trim();
  // An empty generation becomes a clean no-op (success, normal next run) instead of a
  // Telegram 400 + 10-minute retry loop.
  return {
    messages: text ? [text] : [],
    outputSummary: routine.name,
  };
}

export async function runRoutineSkill(params: {
  routine: RoutineRecord;
  profile: Profile;
}): Promise<SkillRunResult> {
  // All routine kinds are AI-generated now. The kind field is retained only so existing
  // rows keep working; behavior no longer branches on it.
  return runGeneratedRoutine(params.routine, params.profile);
}
