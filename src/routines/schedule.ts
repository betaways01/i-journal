import { RoutineSchedule } from './types';

export function getZonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const value = (type: string): number => {
    const part = parts.find((p) => p.type === type)?.value;
    return part ? Number.parseInt(part, 10) : 0;
  };

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const parts = getZonedParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

export function zonedTimeToUtc(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const guess = new Date(Date.UTC(params.year, params.month - 1, params.day, params.hour, params.minute, 0));
  const offset = getTimezoneOffsetMs(guess, params.timezone);
  return new Date(guess.getTime() - offset);
}

function nextLocalDate(parts: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function computeNextRunAt(schedule: RoutineSchedule, after: Date): Date {
  if (schedule.type === 'interval') {
    const minutes = Number.isInteger(schedule.everyMinutes) ? schedule.everyMinutes : 0;
    if (minutes < 1) {
      throw new Error(`Invalid interval routine minutes: ${schedule.everyMinutes}`);
    }
    return new Date(after.getTime() + minutes * 60 * 1000);
  }

  if (schedule.type !== 'daily' && schedule.type !== 'weekly') {
    throw new Error(`Unsupported schedule type: ${(schedule as { type: string }).type}`);
  }

  const [hourRaw, minuteRaw] = schedule.time.split(':');
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Invalid routine time: ${schedule.time}`);
  }

  const local = getZonedParts(after, schedule.timezone);
  let localDate = {
    year: local.year,
    month: local.month,
    day: local.day,
  };

  if (schedule.type === 'weekly') {
    const targetDay = schedule.dayOfWeek;
    if (!Number.isInteger(targetDay) || targetDay < 0 || targetDay > 6) {
      throw new Error(`Invalid weekly routine day: ${targetDay}`);
    }

    const currentLocalNoon = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
    const currentDay = currentLocalNoon.getUTCDay();
    const deltaDays = (targetDay - currentDay + 7) % 7;
    const targetLocalNoon = new Date(
      Date.UTC(local.year, local.month - 1, local.day + deltaDays, 12, 0, 0)
    );
    localDate = {
      year: targetLocalNoon.getUTCFullYear(),
      month: targetLocalNoon.getUTCMonth() + 1,
      day: targetLocalNoon.getUTCDate(),
    };
  }

  let candidate = zonedTimeToUtc({
    ...localDate,
    hour,
    minute,
    timezone: schedule.timezone,
  });

  if (candidate.getTime() <= after.getTime() + 1000) {
    const next = schedule.type === 'weekly'
      ? (() => {
          const nextWeekly = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day + 7, 12, 0, 0));
          return {
            year: nextWeekly.getUTCFullYear(),
            month: nextWeekly.getUTCMonth() + 1,
            day: nextWeekly.getUTCDate(),
          };
        })()
      : nextLocalDate(local);
    candidate = zonedTimeToUtc({
      ...next,
      hour,
      minute,
      timezone: schedule.timezone,
    });
  }

  return candidate;
}

export function retryRunAt(after: Date, minutes = 10): Date {
  return new Date(after.getTime() + minutes * 60 * 1000);
}
