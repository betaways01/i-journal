import { RoutineSchedule } from '../routines/types';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function compactButtonLabel(label: string, max = 34): string {
  const cleaned = label.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3).trim()}...`;
}

export function formatMinutes(minutes: number): string {
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function formatRoutineSchedule(schedule: RoutineSchedule): string {
  if (schedule.type === 'daily') return `daily at ${schedule.time}`;
  if (schedule.type === 'weekly') {
    return `weekly on ${WEEKDAY_NAMES[schedule.dayOfWeek] ?? 'the chosen day'} at ${schedule.time}`;
  }
  return `every ${formatMinutes(schedule.everyMinutes)}`;
}
