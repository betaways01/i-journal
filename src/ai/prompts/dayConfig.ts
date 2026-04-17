import { Profile, ProfileSection, DaySchedule } from '../../profile/defaults';

export function getDayScheduleFromProfile(profile: Profile, date: Date): DaySchedule {
  const dayName = date.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: profile.timezone,
  });
  return (
    profile.schedule[dayName] || {
      tone: 'Regular, balanced',
      extraSections: [],
      context: 'Standard journal day.',
      closingStyle: 'A simple, encouraging closing line.',
    }
  );
}

export function getSectionsForDayFromProfile(profile: Profile, date: Date): ProfileSection[] {
  const daySchedule = getDayScheduleFromProfile(profile, date);
  return [...profile.sections, ...daySchedule.extraSections];
}

export function formatDateForJournal(
  date: Date,
  timezone: string
): { dateStr: string; dayStr: string } {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: timezone });
  const dayStr = date.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: timezone,
  });
  return { dateStr, dayStr };
}
