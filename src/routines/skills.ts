import { Profile } from '../profile/defaults';
import { RoutineRecord, SkillRunResult } from './types';
import { sendMessage } from '../ai';

interface WordItem {
  word: string;
  meaning: string;
  example: string;
  prompt: string;
}

const WORDS: WordItem[] = [
  {
    word: 'rapport',
    meaning: 'An easy, trusting connection with someone.',
    example: 'I tried to build rapport first before discussing the hard part.',
    prompt: 'Use it when you want to describe a conversation that felt warm and easy.',
  },
  {
    word: 'nuance',
    meaning: 'A small but important difference in meaning, feeling, or situation.',
    example: 'There is some nuance here; it is not simply good or bad.',
    prompt: 'Use it when a topic needs a little more care than a quick answer.',
  },
  {
    word: 'concise',
    meaning: 'Clear and short, without unnecessary words.',
    example: 'Let me keep this concise so we can decide quickly.',
    prompt: 'Use it when you want to sound clear, respectful, and focused.',
  },
  {
    word: 'candid',
    meaning: 'Honest and direct, without being harsh.',
    example: 'Can I be candid about what I think is happening?',
    prompt: 'Use it before sharing honest feedback with care.',
  },
  {
    word: 'reframe',
    meaning: 'To look at something from a different angle.',
    example: 'Maybe we can reframe this as a learning moment.',
    prompt: 'Use it when you want to shift a conversation toward possibility.',
  },
  {
    word: 'gracious',
    meaning: 'Kind, generous, and calm, especially when things are tense.',
    example: 'She gave a gracious response even though the question was unfair.',
    prompt: 'Use it when describing someone who handles pressure with kindness.',
  },
  {
    word: 'specific',
    meaning: 'Clear and exact, not vague.',
    example: 'Can you give me a specific example?',
    prompt: 'Use it to make conversations more practical.',
  },
];

function nextWordIndex(routine: RoutineRecord): number {
  const raw = routine.config.lastWordIndex;
  const last = typeof raw === 'number' && Number.isInteger(raw) ? raw : -1;
  return (last + 1) % WORDS.length;
}

function runWordOfDay(routine: RoutineRecord, profile: Profile): SkillRunResult {
  const index = nextWordIndex(routine);
  const item = WORDS[index];
  const goal = typeof routine.config.goal === 'string'
    ? routine.config.goal
    : 'improve daily conversations';

  return {
    messages: [
      [
        `Word for today, ${profile.name}: ${item.word}`,
        '',
        `Meaning: ${item.meaning}`,
        `Use it: "${item.example}"`,
        '',
        item.prompt,
      ].join('\n'),
    ],
    outputSummary: `${item.word} - ${goal}`,
    configUpdate: {
      ...routine.config,
      goal,
      lastWordIndex: index,
    },
  };
}

async function runCustomPrompt(routine: RoutineRecord, profile: Profile): Promise<SkillRunResult> {
  const prompt = typeof routine.config.prompt === 'string'
    ? routine.config.prompt
    : typeof routine.config.goal === 'string'
      ? routine.config.goal
      : routine.name;

  const system = `You are i-Journal running a user-confirmed recurring routine.

Write one short Telegram message for ${profile.name}.
Be useful, warm, and specific. Do not claim you did anything outside the app.

Routine name: ${routine.name}
Routine instruction: ${prompt}
User areas: ${profile.sections.map((s) => s.title).join(', ')}
Timezone: ${profile.timezone}`;

  const message = await sendMessage(system, [], 'Generate this routine message now.');
  return {
    messages: [message.trim()],
    outputSummary: routine.name,
  };
}

export async function runRoutineSkill(params: {
  routine: RoutineRecord;
  profile: Profile;
}): Promise<SkillRunResult> {
  if (params.routine.kind === 'learning.word_of_day') {
    return runWordOfDay(params.routine, params.profile);
  }

  if (params.routine.kind === 'agent.custom_prompt') {
    return runCustomPrompt(params.routine, params.profile);
  }

  throw new Error(`No skill registered for routine kind: ${params.routine.kind}`);
}
