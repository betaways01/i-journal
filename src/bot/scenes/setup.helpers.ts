import { InlineKeyboardButton } from 'telegraf/types';
import { getDefaultProfile, Profile, ProfileSection } from '../../profile/defaults';
import { config } from '../../config';

const DEFAULT_AREAS: ProfileSection[] = [
  { key: 'work', emoji: '⚙️', title: 'Work' },
  { key: 'family', emoji: '👨‍👩‍👧', title: 'Family' },
  { key: 'faith', emoji: '✝️', title: 'Faith' },
  { key: 'personal', emoji: '🌱', title: 'Personal' },
];

const EMOJI_BY_KEY: Record<string, string> = {
  work: '⚙️',
  career: '💼',
  business: '💼',
  clients: '💼',
  family: '👨‍👩‍👧',
  marriage: '💛',
  relationships: '💛',
  friends: '🤝',
  faith: '✝️',
  god: '✝️',
  god_and_ministry: '✝️',
  prayer: '🙏',
  church: '⛪',
  ministry: '⛪',
  personal: '🌱',
  personal_life: '🌱',
  personal_growth: '🌱',
  health: '💪',
  fitness: '💪',
  study: '📚',
  learning: '📚',
  school: '🏫',
  money: '💰',
  finances: '💰',
  creativity: '🎨',
  writing: '✍️',
};

export function defaultAreaSections(): ProfileSection[] {
  return structuredClone(DEFAULT_AREAS);
}

export function todayLocalDate(timezone = config.timezone): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'area';
}

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === 'god') return 'God';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function parseName(text: string): string | null {
  const cleaned = text
    .replace(/^my name is\s+/i, '')
    .replace(/^i am\s+/i, '')
    .replace(/^i'm\s+/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);

  if (!cleaned || cleaned.length < 2) return null;
  return cleaned;
}

export function parseAreaSections(text: string): ProfileSection[] {
  const pieces = text
    .replace(/\band\b/gi, ',')
    .split(/[,\n/;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const sections: ProfileSection[] = [];

  for (const piece of pieces) {
    const title = titleCase(piece);
    const key = normalizeKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({
      key,
      emoji: EMOJI_BY_KEY[key] ?? '📝',
      title,
    });
  }

  return sections.slice(0, 8);
}

function normalizeTime(hourRaw: number, minute: number, context: string, assumeEvening = false): string | null {
  let hour = hourRaw;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  const lower = context.toLowerCase();
  const isMorning = /\b(am|morning|dawn)\b/.test(lower);
  const isEvening = assumeEvening || /\b(pm|evening|night|tonight|journal)\b/.test(lower);

  if (isMorning) {
    if (hour === 12) hour = 0;
  } else if (isEvening) {
    if (hour < 12) hour += 12;
  }

  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseTime(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  const match = trimmed.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/);
  if (!match) return null;

  const hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  return normalizeTime(hour, minute, trimmed);
}

export function parseTwoTimes(text: string): { morningTime: string; eveningTime: string } | null {
  const matches = Array.from(
    text.toLowerCase().matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/g)
  );
  if (matches.length < 2) return null;

  const contextFor = (match: RegExpMatchArray): string => {
    const index = match.index ?? 0;
    return text.slice(Math.max(0, index - 24), Math.min(text.length, index + match[0].length + 24));
  };

  const first = normalizeTime(
    Number.parseInt(matches[0][1], 10),
    matches[0][2] ? Number.parseInt(matches[0][2], 10) : 0,
    contextFor(matches[0])
  );
  const second = normalizeTime(
    Number.parseInt(matches[1][1], 10),
    matches[1][2] ? Number.parseInt(matches[1][2], 10) : 0,
    contextFor(matches[1]),
    true
  );
  if (!first || !second) return null;
  return { morningTime: first, eveningTime: second };
}

export function makeProfile(params: {
  name: string;
  sections: ProfileSection[];
  morningTime: string;
  eveningTime: string;
}): Profile {
  const profile = getDefaultProfile();
  profile.name = params.name;
  profile.sections = params.sections.length > 0 ? params.sections : defaultAreaSections();
  profile.morningTime = params.morningTime;
  profile.eveningTime = params.eveningTime;
  profile.timezone = config.timezone;
  profile.onboardingComplete = true;
  profile.createdAt = todayLocalDate(config.timezone);
  profile.lastReviewDate = profile.createdAt;
  return profile;
}

export function formatAreas(sections: ProfileSection[]): string {
  return sections.map((section) => `• ${section.emoji} ${section.title}`).join('\n');
}

export function formatProfileCard(profile: Profile): string {
  return [
    `You're set up, ${profile.name}.`,
    '',
    "I'll keep track of:",
    formatAreas(profile.sections),
    '',
    `Morning check-in: ${profile.morningTime}`,
    `Evening journal: ${profile.eveningTime}`,
    `Timezone: ${profile.timezone}`,
    '',
    'Entries save to the private app database first. OneNote backup is optional from /storage.',
  ].join('\n');
}

export function settingsMenuKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: 'Name', callback_data: 'settings_name' },
      { text: 'Areas', callback_data: 'settings_areas' },
    ],
    [
      { text: 'Morning time', callback_data: 'settings_morning' },
      { text: 'Evening time', callback_data: 'settings_evening' },
    ],
    [{ text: 'Daily word routine', callback_data: 'settings_word' }],
    [{ text: 'Done', callback_data: 'settings_done' }],
  ];
}
