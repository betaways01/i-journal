import { parseTime } from '../bot/scenes/setup.helpers';
import { getZonedParts, zonedTimeToUtc } from '../routines/schedule';

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

export function parseCountdownMinutes(text: string): number | null {
  const match = text.match(
    /\bin\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/i
  );
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount < 1) return null;

  const unit = match[2].toLowerCase();
  if (unit.startsWith('m')) return amount;
  if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) return amount * 60;
  if (unit === 'd' || unit.startsWith('day')) return amount * 24 * 60;
  return amount * 7 * 24 * 60;
}

export function parseIntervalEveryMinutes(text: string): number | null {
  const match = text.match(
    /\bevery\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/i
  );
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount < 1) return null;

  const unit = match[2].toLowerCase();
  if (unit.startsWith('m')) return amount;
  if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) return amount * 60;
  if (unit === 'd' || unit.startsWith('day')) return amount * 24 * 60;
  return amount * 7 * 24 * 60;
}

export function parseWeekday(text: string): number | null {
  const match = text.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday|rday)?|fri(?:day)?|sat(?:urday)?)\b/i);
  if (!match) return null;
  return WEEKDAYS[match[1].toLowerCase()] ?? null;
}

export function parseFlexibleTime(text: string): string | null {
  const atMatch = text.match(/\bat\s+([^,.]+)/i);
  if (atMatch) {
    const parsed = parseTime(atMatch[1]);
    if (parsed) return parsed;
  }
  return parseTime(text);
}

export function fireAtFromCountdown(minutes: number, now = new Date()): Date {
  return new Date(now.getTime() + minutes * 60 * 1000);
}

export function fireAtFromLocalDateTime(params: {
  date: string;
  time: string;
  timezone: string;
}): Date | null {
  const dateMatch = params.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const [hourRaw, minuteRaw] = params.time.split(':');
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  return zonedTimeToUtc({
    year: Number.parseInt(dateMatch[1], 10),
    month: Number.parseInt(dateMatch[2], 10),
    day: Number.parseInt(dateMatch[3], 10),
    hour,
    minute,
    timezone: params.timezone,
  });
}

export function nextLocalFireAt(params: {
  text: string;
  timezone: string;
  now?: Date;
}): Date | null {
  const now = params.now ?? new Date();
  const countdown = parseCountdownMinutes(params.text);
  if (countdown) return fireAtFromCountdown(countdown, now);

  const time = parseFlexibleTime(params.text);
  if (!time) return null;

  const local = getZonedParts(now, params.timezone);
  const lower = params.text.toLowerCase();
  let dayOffset = lower.includes('tomorrow') ? 1 : 0;

  const weekday = parseWeekday(params.text);
  if (weekday !== null) {
    const localNoon = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
    const currentDay = localNoon.getUTCDay();
    dayOffset = (weekday - currentDay + 7) % 7;
  }

  const targetNoon = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset, 12, 0, 0));
  let fireAt = zonedTimeToUtc({
    year: targetNoon.getUTCFullYear(),
    month: targetNoon.getUTCMonth() + 1,
    day: targetNoon.getUTCDate(),
    hour: Number.parseInt(time.split(':')[0], 10),
    minute: Number.parseInt(time.split(':')[1], 10),
    timezone: params.timezone,
  });

  if (!lower.includes('today') && !lower.includes('tomorrow') && fireAt.getTime() <= now.getTime() + 1000) {
    const tomorrowNoon = new Date(
      Date.UTC(targetNoon.getUTCFullYear(), targetNoon.getUTCMonth(), targetNoon.getUTCDate() + 1, 12, 0, 0)
    );
    fireAt = zonedTimeToUtc({
      year: tomorrowNoon.getUTCFullYear(),
      month: tomorrowNoon.getUTCMonth() + 1,
      day: tomorrowNoon.getUTCDate(),
      hour: Number.parseInt(time.split(':')[0], 10),
      minute: Number.parseInt(time.split(':')[1], 10),
      timezone: params.timezone,
    });
  }

  return fireAt;
}

export function formatLocalDateTime(date: Date, timezone: string): string {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
