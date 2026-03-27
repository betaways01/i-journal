import fs from 'fs';
import path from 'path';

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
  onboardingComplete: boolean;
  createdAt: string;
  lastReviewDate: string;
}

const PROFILE_FILE = path.join(__dirname, '../../state/profile.json');

const DEFAULT_SCHEDULE: Record<string, DaySchedule> = {
  Monday: {
    tone: 'Energetic, intentional',
    extraSections: [{ key: 'class', emoji: '📚', title: 'Evening Class' }],
    context: 'Ask about evening class (7-8 PM) — what was learned and key takeaways.',
    closingStyle: 'A short, energizing line to carry momentum into Tuesday.',
  },
  Tuesday: {
    tone: 'Regular, balanced',
    extraSections: [],
    context: 'Standard full journal day — no special events.',
    closingStyle: 'A simple, encouraging closing line.',
  },
  Wednesday: {
    tone: 'Gentle, spiritually aware',
    extraSections: [{ key: 'fast', emoji: '🕊️', title: 'Fasting' }],
    context: 'Fasting day (skips lunch) — a spiritual discipline. Acknowledge it warmly.',
    closingStyle: 'A faith-anchored line acknowledging the discipline of fasting.',
  },
  Thursday: {
    tone: 'Reflective, teacher-mode',
    extraSections: [{ key: 'teaching', emoji: '🎓', title: 'Teaching' }],
    context: 'Teaching session 8:45-9:45 PM. Ask how it went and any student moments.',
    closingStyle: 'A reflective line about pouring into others.',
  },
  Friday: {
    tone: 'Warm, transitional',
    extraSections: [],
    context: 'Weekend approaching. Is he present for family or carrying work stress?',
    closingStyle: 'A warm transition into the weekend — rest and presence.',
  },
  Saturday: {
    tone: 'Light, restful',
    extraSections: [],
    context: 'Rest/family day. Any family outings or special moments? Energy check.',
    closingStyle: 'A light, restful line. Encourage preparation for Sunday.',
  },
  Sunday: {
    tone: 'Faith-anchored, reflective',
    extraSections: [{ key: 'church', emoji: '⛪', title: 'Church & Worship' }],
    context: 'Church day. Sermon highlights, worship moments, spiritual state. Ready for new week?',
    closingStyle: 'A short blessing over the week ahead.',
  },
};

const DEFAULT_PROFILE: Profile = {
  name: 'Francis',
  sections: [
    { key: 'work', emoji: '⚙️', title: 'Work & Build' },
    { key: 'content', emoji: '📢', title: 'Content & Marketing' },
    { key: 'family', emoji: '👨‍👩‍👧', title: 'Family' },
    { key: 'faith', emoji: '✝️', title: 'Relationship with God' },
    { key: 'personal', emoji: '🌱', title: 'Personal' },
  ],
  schedule: DEFAULT_SCHEDULE,
  morningTime: '06:00',
  eveningTime: '21:00',
  onboardingComplete: false,
  createdAt: '',
  lastReviewDate: '',
};

let cachedProfile: Profile | null = null;

export function getProfile(): Profile {
  if (cachedProfile) return cachedProfile;

  try {
    const data = fs.readFileSync(PROFILE_FILE, 'utf-8');
    cachedProfile = JSON.parse(data);
    return cachedProfile!;
  } catch {
    return structuredClone(DEFAULT_PROFILE);
  }
}

export function saveProfile(profile: Profile): void {
  const dir = path.dirname(PROFILE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
  cachedProfile = profile;
}

export function profileExists(): boolean {
  return fs.existsSync(PROFILE_FILE);
}

export function getDefaultProfile(): Profile {
  return structuredClone(DEFAULT_PROFILE);
}

export function needsReview(): boolean {
  const profile = getProfile();
  if (!profile.lastReviewDate) return false;

  const last = new Date(profile.lastReviewDate);
  const now = new Date();
  const diffDays = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 30;
}
