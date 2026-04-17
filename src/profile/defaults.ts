export interface ProfileSection {
  key: string;
  emoji: string;
  title: string;
}

export interface DaySchedule {
  tone: string;
  extraSections: ProfileSection[];
  context: string;
  closingStyle: string;
}

export interface Profile {
  name: string;
  sections: ProfileSection[];
  schedule: Record<string, DaySchedule>;
  morningTime: string;
  eveningTime: string;
  timezone: string;
  onboardingComplete: boolean;
  createdAt: string;
  lastReviewDate: string;
}

const DEFAULT_SCHEDULE: Record<string, DaySchedule> = {
  Monday: {
    tone: 'Energetic, intentional',
    extraSections: [],
    context: 'Standard journal day — no special events unless you say otherwise.',
    closingStyle: 'A short, energizing line to carry momentum into Tuesday.',
  },
  Tuesday: {
    tone: 'Regular, balanced',
    extraSections: [],
    context: 'Standard journal day.',
    closingStyle: 'A simple, encouraging closing line.',
  },
  Wednesday: {
    tone: 'Regular, balanced',
    extraSections: [],
    context: 'Standard journal day.',
    closingStyle: 'A simple, encouraging closing line.',
  },
  Thursday: {
    tone: 'Regular, balanced',
    extraSections: [],
    context: 'Standard journal day.',
    closingStyle: 'A simple, encouraging closing line.',
  },
  Friday: {
    tone: 'Warm, transitional',
    extraSections: [],
    context: 'Weekend approaching. Invite reflection on presence vs. work carry-over.',
    closingStyle: 'A warm transition into the weekend — rest and presence.',
  },
  Saturday: {
    tone: 'Light, restful',
    extraSections: [],
    context: 'Rest/family day. Any special moments? Energy check.',
    closingStyle: 'A light, restful line.',
  },
  Sunday: {
    tone: 'Faith-anchored, reflective',
    extraSections: [],
    context: 'Reflective day. Ready for the new week?',
    closingStyle: 'A short blessing over the week ahead.',
  },
};

const DEFAULT_PROFILE: Profile = {
  name: 'Friend',
  sections: [
    { key: 'work', emoji: '⚙️', title: 'Work' },
    { key: 'family', emoji: '👨‍👩‍👧', title: 'Family' },
    { key: 'faith', emoji: '✝️', title: 'Faith' },
    { key: 'personal', emoji: '🌱', title: 'Personal' },
  ],
  schedule: DEFAULT_SCHEDULE,
  morningTime: '06:00',
  eveningTime: '21:00',
  timezone: 'Africa/Nairobi',
  onboardingComplete: false,
  createdAt: '',
  lastReviewDate: '',
};

export function getDefaultProfile(): Profile {
  return structuredClone(DEFAULT_PROFILE);
}

function normalizeSection(s: any): ProfileSection {
  return {
    key:
      s.key ||
      s.title?.toLowerCase().replace(/\s+/g, '_') ||
      s.name?.toLowerCase().replace(/\s+/g, '_') ||
      'unknown',
    emoji: s.emoji || s.icon || '',
    title: s.title || s.name || s.label || s.key || 'Untitled',
  };
}

function normalizeDaySchedule(d: any): DaySchedule {
  let extraSections: ProfileSection[] = [];
  if (Array.isArray(d.extraSections)) {
    extraSections = d.extraSections.map((s: any) =>
      typeof s === 'string'
        ? { key: s.toLowerCase().replace(/\s+/g, '_'), emoji: '', title: s }
        : normalizeSection(s)
    );
  } else if (Array.isArray(d.events)) {
    extraSections = d.events.map((e: any) =>
      typeof e === 'string'
        ? { key: e.toLowerCase().replace(/\s+/g, '_'), emoji: '', title: e }
        : normalizeSection(e)
    );
  }

  return {
    tone: d.tone || 'Regular, balanced',
    extraSections,
    context: d.context || d.specialContext || 'Standard journal day.',
    closingStyle: d.closingStyle || d.closingLine || d.eveningClosingStyle || 'A simple, encouraging closing line.',
  };
}

export function normalizeProfile(raw: any): Partial<Profile> {
  const result: Partial<Profile> = {};

  if (raw.name) result.name = raw.name;
  if (raw.morningTime) result.morningTime = raw.morningTime;
  if (raw.eveningTime) result.eveningTime = raw.eveningTime;
  if (raw.timezone) result.timezone = raw.timezone;

  if (Array.isArray(raw.sections)) {
    result.sections = raw.sections.map(normalizeSection);
  }

  if (raw.schedule && typeof raw.schedule === 'object') {
    result.schedule = {};
    for (const [day, sched] of Object.entries(raw.schedule)) {
      result.schedule[day] = normalizeDaySchedule(sched);
    }
  }

  return result;
}
