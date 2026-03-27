import { getProfile, ProfileSection, DaySchedule } from '../../profile';
import { config } from '../../config';

export function getDaySchedule(date: Date): DaySchedule {
  const dayName = date.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: config.timezone,
  });
  const profile = getProfile();
  return (
    profile.schedule[dayName] || {
      tone: 'Regular, balanced',
      extraSections: [],
      context: 'Standard journal day.',
      closingStyle: 'A simple, encouraging closing line.',
    }
  );
}

export function getSectionsForDay(date: Date): ProfileSection[] {
  const profile = getProfile();
  const daySchedule = getDaySchedule(date);
  return [...profile.sections, ...daySchedule.extraSections];
}

export function formatDateForJournal(date: Date): { dateStr: string; dayStr: string } {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: config.timezone });
  const dayStr = date.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: config.timezone,
  });
  return { dateStr, dayStr };
}
