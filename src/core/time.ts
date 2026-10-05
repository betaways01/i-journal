/**
 * Timezone-correct date/time helpers. Pure: no I/O, no dependence on the process timezone.
 * Tool arguments are parsed here as machine formats only (enums and ISO strings), never as prose.
 */
import { Recurrence } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    formatterFor(tz.trim());
    return true;
  } catch {
    return false;
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function ymd(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

interface Fields {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function fieldsAt(ms: number, tz: string): Fields {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  let h = get('hour');
  if (h === 24) h = 0;
  return { y: get('year'), mo: get('month'), d: get('day'), h, mi: get('minute'), s: get('second') };
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (east positive). */
function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const f = fieldsAt(whole, tz);
  const asUtc = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  return Math.round((asUtc - whole) / MINUTE);
}

export function localParts(
  at: Date,
  tz: string
): { date: string; time: string; weekday: string; hour: number; minute: number; offsetMinutes: number } {
  const ms = at.getTime();
  const f = fieldsAt(ms, tz);
  const date = ymd(f.y, f.mo, f.d);
  return {
    date,
    time: `${pad(f.h)}:${pad(f.mi)}`,
    weekday: weekdayOf(date),
    hour: f.h,
    minute: f.mi,
    offsetMinutes: offsetAt(ms, tz),
  };
}

function splitDate(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

function dayIndex(date: string): number {
  const [y, m, d] = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function weekdayOf(date: string): string {
  return WEEKDAYS[dayIndex(date)];
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = splitDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isIsoDate(s: string): boolean {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function resolveDay(input: string | undefined, now: Date, tz: string): string | null {
  const raw = (input ?? '').trim().toLowerCase();
  const today = localParts(now, tz).date;
  if (!raw || raw === 'today') return today;
  if (raw === 'yesterday') return shiftDate(today, -1);
  if (raw === 'tomorrow') return shiftDate(today, 1);
  return isIsoDate(raw) ? raw : null;
}

export function parseLocalDateTime(s: string): { date: string; hour: number; minute: number } | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s.trim());
  if (!m || !isIsoDate(m[1])) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  return { date: m[1], hour, minute };
}

function wallMatches(ms: number, tz: string, date: string, hour: number, minute: number): boolean {
  const f = fieldsAt(ms, tz);
  return ymd(f.y, f.mo, f.d) === date && f.h === hour && f.mi === minute;
}

export function zonedToUtc(date: string, hour: number, minute: number, tz: string): Date {
  const [y, mo, d] = splitDate(date);
  const guess = Date.UTC(y, mo - 1, d, hour, minute);
  const offsets = new Set([offsetAt(guess - DAY, tz), offsetAt(guess, tz), offsetAt(guess + DAY, tz)]);
  const valid = [...offsets]
    .map((off) => guess - off * MINUTE)
    .filter((ms) => wallMatches(ms, tz, date, hour, minute))
    .sort((a, b) => a - b);
  if (valid.length) return new Date(valid[0]);

  // Wall time falls in a DST gap: return the first instant after the transition.
  const before = offsetAt(guess - DAY, tz);
  const after = offsetAt(guess + DAY, tz);
  let lo = guess - Math.max(before, after) * MINUTE;
  let hi = guess - Math.min(before, after) * MINUTE;
  if (lo > hi) [lo, hi] = [hi, lo];
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid, tz) === after) hi = mid;
    else lo = mid;
  }
  return new Date(offsetAt(lo, tz) === after ? lo : hi);
}

export function formatLocal(at: Date, tz: string): string {
  const p = localParts(at, tz);
  const [y, m, d] = splitDate(p.date);
  return `${WEEKDAY_SHORT[dayIndex(p.date)]} ${d} ${MONTH_SHORT[m - 1]} ${y}, ${p.time}`;
}

export function formatDelta(ms: number): string {
  if (!Number.isFinite(ms)) return 'now';
  const abs = Math.abs(ms);
  if (abs < 1000) return 'now';
  let body: string;
  if (abs < MINUTE) {
    const s = Math.round(abs / 1000);
    body = `${s} second${s === 1 ? '' : 's'}`;
  } else if (abs < HOUR) {
    const m = Math.round(abs / MINUTE);
    body = m >= 60 ? '1h 0m' : `${m} minute${m === 1 ? '' : 's'}`;
  } else if (abs < DAY) {
    const totalMin = Math.round(abs / MINUTE);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    body = h >= 24 ? '1 day 0h' : `${h}h ${m}m`;
  } else {
    const totalH = Math.round(abs / HOUR);
    const dd = Math.floor(totalH / 24);
    const h = totalH % 24;
    body = `${dd} day${dd === 1 ? '' : 's'} ${h}h`;
  }
  return ms > 0 ? `in ${body}` : `${body} ago`;
}

function safeInterval(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.floor(v);
}

function addMonths(y: number, m: number, k: number): [number, number] {
  const idx = y * 12 + (m - 1) + k;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

export function nextOccurrence(rec: Recurrence, last: Date, now: Date, tz: string): Date {
  const interval = safeInterval(rec.interval);
  const lastMs = last.getTime();
  const floor = Math.max(lastMs, now.getTime());

  if (rec.freq === 'minutely' || rec.freq === 'hourly') {
    const step = interval * (rec.freq === 'minutely' ? MINUTE : HOUR);
    const n = Math.floor((floor - lastMs) / step) + 1;
    return new Date(lastMs + n * step);
  }

  const lp = localParts(last, tz);
  const { hour, minute } = lp;
  const at = (date: string): number => zonedToUtc(date, hour, minute, tz).getTime();

  if (rec.freq === 'daily') {
    const span = interval * DAY;
    let k = Math.max(1, Math.floor((floor - lastMs) / span) - 1);
    for (let guard = 0; guard < 10_000; guard++, k++) {
      const t = at(shiftDate(lp.date, k * interval));
      if (t > floor) return new Date(t);
    }
    throw new Error('nextOccurrence: daily did not converge');
  }

  if (rec.freq === 'weekly') {
    const days = [...new Set((rec.weekdays || []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
      (a, b) => a - b
    );
    const weekdays = days.length ? days : [dayIndex(lp.date)];
    const weekStart = shiftDate(lp.date, -dayIndex(lp.date));
    const weeksElapsed = Math.floor((floor - lastMs) / (7 * DAY));
    let w = Math.max(0, Math.floor(weeksElapsed / interval) - 1) * interval;
    for (let guard = 0; guard < 10_000; guard++, w += interval) {
      for (const wd of weekdays) {
        const t = at(shiftDate(weekStart, w * 7 + wd));
        if (t > floor) return new Date(t);
      }
    }
    throw new Error('nextOccurrence: weekly did not converge');
  }

  // monthly: always computed from the anchor day so a clamp (31 -> 28) never drifts permanently.
  const [y0, m0, dom] = splitDate(lp.date);
  const monthsElapsed = Math.floor((floor - lastMs) / (28 * DAY));
  let k = Math.max(1, Math.floor(monthsElapsed / interval) - 1);
  for (let guard = 0; guard < 10_000; guard++, k++) {
    const [y, m] = addMonths(y0, m0, k * interval);
    const t = at(ymd(y, m, Math.min(dom, daysInMonth(y, m))));
    if (t > floor) return new Date(t);
  }
  throw new Error('nextOccurrence: monthly did not converge');
}

const FREQS = new Set(['minutely', 'hourly', 'daily', 'weekly', 'monthly']);

export function validateRecurrence(input: unknown): Recurrence | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const freq = typeof o.freq === 'string' ? o.freq.trim().toLowerCase() : '';
  if (!FREQS.has(freq)) return null;
  let interval = 1;
  if (o.interval !== undefined && o.interval !== null && o.interval !== '') {
    const n = typeof o.interval === 'number' ? o.interval : Number(o.interval);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return null;
    interval = n;
  }
  const rec: Recurrence = { freq: freq as Recurrence['freq'], interval };
  if (freq === 'weekly' && o.weekdays !== undefined && o.weekdays !== null) {
    if (!Array.isArray(o.weekdays)) return null;
    const days: number[] = [];
    for (const raw of o.weekdays) {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 6) return null;
      if (!days.includes(n)) days.push(n);
    }
    if (days.length) rec.weekdays = days.sort((a, b) => a - b);
  }
  return rec;
}
