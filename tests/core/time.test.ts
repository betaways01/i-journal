import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDelta,
  formatLocal,
  isIsoDate,
  isValidTimezone,
  localParts,
  nextOccurrence,
  parseLocalDateTime,
  resolveDay,
  shiftDate,
  validateRecurrence,
  weekdayOf,
  zonedToUtc,
} from '../../src/core/time';
import { Recurrence } from '../../src/core/types';

const RUH = 'Asia/Riyadh';
const NY = 'America/New_York';
const LON = 'Europe/London';
const KOL = 'Asia/Kolkata';
const KTM = 'Asia/Kathmandu';

const iso = (s: string) => new Date(s);
const local = (at: Date, tz: string) => {
  const p = localParts(at, tz);
  return `${p.date} ${p.time}`;
};

test('isValidTimezone', () => {
  for (const tz of [RUH, NY, LON, KOL, KTM, 'UTC']) assert.equal(isValidTimezone(tz), true, tz);
  for (const tz of ['', '   ', 'Mars/Olympus', 'GMT+99', 'not a zone']) assert.equal(isValidTimezone(tz), false, tz);
  assert.equal(isValidTimezone(undefined as unknown as string), false);
});

test('localParts across zones', () => {
  const at = iso('2026-10-02T12:02:30Z');
  assert.deepEqual(localParts(at, RUH), {
    date: '2026-10-02',
    time: '15:02',
    weekday: 'Friday',
    hour: 15,
    minute: 2,
    offsetMinutes: 180,
  });
  assert.equal(localParts(at, NY).offsetMinutes, -240);
  assert.equal(localParts(at, LON).offsetMinutes, 60);
  assert.equal(localParts(at, KOL).offsetMinutes, 330);
  assert.equal(localParts(at, KOL).time, '17:32');
  assert.equal(localParts(at, KTM).offsetMinutes, 345);
  assert.equal(localParts(at, KTM).time, '17:47');
  assert.equal(localParts(iso('2026-01-15T12:00:00Z'), NY).offsetMinutes, -300);
  assert.equal(localParts(iso('2026-01-15T12:00:00Z'), LON).offsetMinutes, 0);
});

test('localParts at midnight never reports hour 24', () => {
  const p = localParts(iso('2026-10-01T21:00:00Z'), RUH);
  assert.equal(p.date, '2026-10-02');
  assert.equal(p.time, '00:00');
  assert.equal(p.hour, 0);
});

test('local date differs from UTC date just after local midnight', () => {
  const at = iso('2026-10-01T21:30:00Z');
  assert.equal(resolveDay('today', at, RUH), '2026-10-02');
  assert.equal(resolveDay(undefined, at, RUH), '2026-10-02');
  assert.equal(resolveDay('', at, RUH), '2026-10-02');
  assert.equal(resolveDay('yesterday', at, RUH), '2026-10-01');
  assert.equal(resolveDay('tomorrow', at, RUH), '2026-10-03');
  assert.equal(resolveDay('today', at, 'UTC'), '2026-10-01');
  assert.equal(resolveDay(' Yesterday ', at, RUH), '2026-10-01');
});

test('resolveDay rejects prose', () => {
  const at = iso('2026-10-02T09:00:00Z');
  assert.equal(resolveDay('2026-09-30', at, RUH), '2026-09-30');
  for (const bad of ['last tuesday', 'monday', '2026-02-30', '30/09/2026', 'next week', '2026-9-3']) {
    assert.equal(resolveDay(bad, at, RUH), null, bad);
  }
});

test('weekdayOf and shiftDate', () => {
  assert.equal(weekdayOf('2026-10-02'), 'Friday');
  assert.equal(weekdayOf('2024-02-29'), 'Thursday');
  assert.equal(weekdayOf('2000-01-01'), 'Saturday');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDate('2025-02-28', 1), '2025-03-01');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-10-02', 0), '2026-10-02');
  assert.equal(shiftDate('2026-10-02', 365), '2027-10-02');
  assert.equal(shiftDate('2026-03-07', 2), '2026-03-09');
});

test('isIsoDate', () => {
  for (const ok of ['2026-10-02', '2024-02-29', '2000-02-29', '1999-12-31']) assert.equal(isIsoDate(ok), true, ok);
  for (const bad of ['2026-02-30', '2025-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-10-2', '20261002', '', 'today', '2026-10-02T00:00'])
    assert.equal(isIsoDate(bad), false, bad);
});

test('parseLocalDateTime', () => {
  assert.deepEqual(parseLocalDateTime('2026-10-02 15:02'), { date: '2026-10-02', hour: 15, minute: 2 });
  assert.deepEqual(parseLocalDateTime('2026-10-02T15:02'), { date: '2026-10-02', hour: 15, minute: 2 });
  assert.deepEqual(parseLocalDateTime('2026-10-02T15:02:59'), { date: '2026-10-02', hour: 15, minute: 2 });
  assert.deepEqual(parseLocalDateTime(' 2026-10-02 9:05 '), { date: '2026-10-02', hour: 9, minute: 5 });
  assert.deepEqual(parseLocalDateTime('2026-10-02 00:00'), { date: '2026-10-02', hour: 0, minute: 0 });
  for (const bad of ['2026-10-02 24:00', '2026-10-02 12:60', '2026-02-30 10:00', '15:02', 'tomorrow 3pm', '2026-10-02', '2026-10-02 3pm', '1502hrs', ''])
    assert.equal(parseLocalDateTime(bad), null, bad);
  assert.equal(parseLocalDateTime(42 as unknown as string), null);
});

test('zonedToUtc basic zones', () => {
  assert.equal(zonedToUtc('2026-10-02', 15, 2, RUH).toISOString(), '2026-10-02T12:02:00.000Z');
  assert.equal(zonedToUtc('2026-10-02', 0, 30, RUH).toISOString(), '2026-10-01T21:30:00.000Z');
  assert.equal(zonedToUtc('2026-10-02', 9, 0, KOL).toISOString(), '2026-10-02T03:30:00.000Z');
  assert.equal(zonedToUtc('2026-10-02', 9, 0, KTM).toISOString(), '2026-10-02T03:15:00.000Z');
  assert.equal(zonedToUtc('2026-07-01', 9, 0, LON).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', 9, 0, LON).toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-31', 23, 59, 'UTC').toISOString(), '2026-12-31T23:59:00.000Z');
});

test('zonedToUtc DST gap moves to the first instant after the transition', () => {
  // New York springs forward 2026-03-08 02:00 -> 03:00 local (07:00Z).
  const t = zonedToUtc('2026-03-08', 2, 30, NY);
  assert.equal(t.toISOString(), '2026-03-08T07:00:00.000Z');
  assert.equal(local(t, NY), '2026-03-08 03:00');
  // London springs forward 2026-03-29 01:00 -> 02:00.
  const l = zonedToUtc('2026-03-29', 1, 15, LON);
  assert.equal(local(l, LON), '2026-03-29 02:00');
});

test('zonedToUtc DST overlap picks the earlier instant', () => {
  // New York falls back 2026-11-01 02:00 EDT -> 01:00 EST. 01:30 happens twice.
  const t = zonedToUtc('2026-11-01', 1, 30, NY);
  assert.equal(t.toISOString(), '2026-11-01T05:30:00.000Z');
  const l = zonedToUtc('2026-10-25', 1, 30, LON);
  assert.equal(l.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('round trip localParts -> zonedToUtc for many instants', () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const start = Date.UTC(2024, 0, 1);
  const span = Date.UTC(2028, 0, 1) - start;
  for (const tz of [RUH, NY, LON, KOL, KTM]) {
    for (let i = 0; i < 500; i++) {
      const ms = Math.floor((start + rand() * span) / 60000) * 60000;
      const p = localParts(new Date(ms), tz);
      const back = zonedToUtc(p.date, p.hour, p.minute, tz).getTime();
      if (back !== ms) {
        // Only legitimate inside a fall-back overlap, where the earlier instant is chosen.
        assert.ok(back < ms && ms - back <= 3600_000, `${tz} ${new Date(ms).toISOString()} -> ${new Date(back).toISOString()}`);
      }
    }
  }
});

test('formatLocal', () => {
  assert.equal(formatLocal(iso('2026-10-02T12:02:00Z'), RUH), 'Fri 2 Oct 2026, 15:02');
  assert.equal(formatLocal(iso('2026-10-01T21:05:00Z'), RUH), 'Fri 2 Oct 2026, 00:05');
  assert.equal(formatLocal(iso('2026-01-01T04:59:00Z'), NY), 'Wed 31 Dec 2025, 23:59');
});

test('formatDelta', () => {
  assert.equal(formatDelta(0), 'now');
  assert.equal(formatDelta(999), 'now');
  assert.equal(formatDelta(45_000), 'in 45 seconds');
  assert.equal(formatDelta(1_000), 'in 1 second');
  assert.equal(formatDelta(60_000), 'in 1 minute');
  assert.equal(formatDelta(5 * 60_000), 'in 5 minutes');
  assert.equal(formatDelta(59 * 60_000 + 40_000), 'in 1h 0m');
  assert.equal(formatDelta(72 * 60_000), 'in 1h 12m');
  assert.equal(formatDelta((2 * 24 + 3) * 3600_000), 'in 2 days 3h');
  assert.equal(formatDelta(24 * 3600_000), 'in 1 day 0h');
  assert.equal(formatDelta(-5 * 60_000), '5 minutes ago');
  assert.equal(formatDelta(-3 * 3600_000), '3h 0m ago');
  assert.equal(formatDelta(Number.NaN), 'now');
});

const rec = (freq: Recurrence['freq'], interval = 1, weekdays?: number[]): Recurrence => ({ freq, interval, weekdays });

test('nextOccurrence minutely and hourly step in absolute time', () => {
  const last = iso('2026-10-02T12:00:00Z');
  assert.equal(nextOccurrence(rec('minutely'), last, last, RUH).toISOString(), '2026-10-02T12:01:00.000Z');
  assert.equal(nextOccurrence(rec('minutely', 3), last, iso('2026-10-02T12:07:30Z'), RUH).toISOString(), '2026-10-02T12:09:00.000Z');
  assert.equal(nextOccurrence(rec('hourly'), last, iso('2026-10-02T12:00:00Z'), RUH).toISOString(), '2026-10-02T13:00:00.000Z');
  assert.equal(nextOccurrence(rec('hourly', 3), last, iso('2026-10-02T15:00:00Z'), RUH).toISOString(), '2026-10-02T18:00:00.000Z');
  // DST does not matter for absolute steps.
  const ny = iso('2026-03-08T06:00:00Z');
  assert.equal(nextOccurrence(rec('hourly'), ny, ny, NY).toISOString(), '2026-03-08T07:00:00.000Z');
});

test('nextOccurrence daily keeps wall time and skips missed days', () => {
  const last = zonedToUtc('2026-10-02', 6, 0, RUH);
  assert.equal(local(nextOccurrence(rec('daily'), last, last, RUH), RUH), '2026-10-03 06:00');
  const late = zonedToUtc('2026-10-05', 9, 0, RUH);
  assert.equal(local(nextOccurrence(rec('daily'), last, late, RUH), RUH), '2026-10-06 06:00');
  assert.equal(local(nextOccurrence(rec('daily', 3), last, last, RUH), RUH), '2026-10-05 06:00');
  assert.equal(local(nextOccurrence(rec('daily', 3), last, late, RUH), RUH), '2026-10-08 06:00');
});

test('nextOccurrence daily preserves 09:00 across DST in New York', () => {
  const last = zonedToUtc('2026-03-07', 9, 0, NY);
  const next = nextOccurrence(rec('daily'), last, last, NY);
  assert.equal(local(next, NY), '2026-03-08 09:00');
  assert.equal(next.getTime() - last.getTime(), 23 * 3600_000);
  const fall = zonedToUtc('2026-10-31', 9, 0, NY);
  const after = nextOccurrence(rec('daily'), fall, fall, NY);
  assert.equal(local(after, NY), '2026-11-01 09:00');
  assert.equal(after.getTime() - fall.getTime(), 25 * 3600_000);
});

test('nextOccurrence weekly single and multi weekday', () => {
  const fri = zonedToUtc('2026-10-02', 7, 30, RUH); // Friday
  assert.equal(local(nextOccurrence(rec('weekly'), fri, fri, RUH), RUH), '2026-10-09 07:30');
  const monWedFri = rec('weekly', 1, [1, 3, 5]);
  assert.equal(local(nextOccurrence(monWedFri, fri, fri, RUH), RUH), '2026-10-05 07:30');
  const mon = zonedToUtc('2026-10-05', 7, 30, RUH);
  assert.equal(local(nextOccurrence(monWedFri, mon, mon, RUH), RUH), '2026-10-07 07:30');
  // every 3 weeks on Sunday and Friday, anchored to the week of `last`
  const every3 = rec('weekly', 3, [0, 5]);
  assert.equal(local(nextOccurrence(every3, fri, fri, RUH), RUH), '2026-10-18 07:30');
  const sun = zonedToUtc('2026-10-18', 7, 30, RUH);
  assert.equal(local(nextOccurrence(every3, sun, sun, RUH), RUH), '2026-10-23 07:30');
});

test('nextOccurrence monthly clamps without drifting', () => {
  let t = zonedToUtc('2026-01-31', 8, 0, RUH);
  const anchor = t;
  const seen: string[] = [];
  // Each next is computed from the original anchor so the 31st comes back after a short month.
  for (let i = 0; i < 4; i++) {
    t = nextOccurrence(rec('monthly'), anchor, t, RUH);
    seen.push(local(t, RUH));
  }
  assert.deepEqual(seen, ['2026-02-28 08:00', '2026-03-31 08:00', '2026-04-30 08:00', '2026-05-31 08:00']);
  const leap = zonedToUtc('2028-01-31', 8, 0, RUH);
  assert.equal(local(nextOccurrence(rec('monthly'), leap, leap, RUH), RUH), '2028-02-29 08:00');
  const q = zonedToUtc('2026-01-15', 8, 0, RUH);
  assert.equal(local(nextOccurrence(rec('monthly', 3), q, q, RUH), RUH), '2026-04-15 08:00');
  assert.equal(local(nextOccurrence(rec('monthly'), zonedToUtc('2026-12-10', 8, 0, RUH), zonedToUtc('2026-12-10', 8, 0, RUH), RUH), RUH), '2027-01-10 08:00');
});

test('nextOccurrence never returns the past and handles very old last', () => {
  const now = iso('2026-10-02T12:00:00Z');
  const ancient = zonedToUtc('1990-01-01', 6, 0, RUH);
  for (const r of [rec('minutely'), rec('hourly', 5), rec('daily'), rec('daily', 7), rec('weekly', 2, [2, 4]), rec('monthly'), rec('monthly', 5)]) {
    const t0 = Date.now();
    const next = nextOccurrence(r, ancient, now, RUH);
    assert.ok(next.getTime() > now.getTime(), `${r.freq} ${r.interval} -> ${next.toISOString()}`);
    assert.ok(Date.now() - t0 < 200, `${r.freq} took too long`);
  }
  // last in the future: strictly after last
  const future = iso('2026-12-01T03:00:00Z');
  assert.ok(nextOccurrence(rec('daily'), future, now, RUH).getTime() > future.getTime());
});

test('nextOccurrence invalid interval treated as 1', () => {
  const last = zonedToUtc('2026-10-02', 6, 0, RUH);
  for (const bad of [0, -2, Number.NaN]) {
    assert.equal(local(nextOccurrence({ freq: 'daily', interval: bad }, last, last, RUH), RUH), '2026-10-03 06:00');
  }
});

test('validateRecurrence', () => {
  assert.deepEqual(validateRecurrence({ freq: 'daily' }), { freq: 'daily', interval: 1 });
  assert.deepEqual(validateRecurrence({ freq: 'Weekly', interval: '2', weekdays: [5, 1, 1, '3'] }), {
    freq: 'weekly',
    interval: 2,
    weekdays: [1, 3, 5],
  });
  assert.deepEqual(validateRecurrence({ freq: 'monthly', interval: 1, weekdays: [1] }), { freq: 'monthly', interval: 1 });
  assert.deepEqual(validateRecurrence({ freq: 'weekly', weekdays: [] }), { freq: 'weekly', interval: 1 });
  for (const bad of [null, undefined, 'daily', [], {}, { freq: 'yearly' }, { freq: 'daily', interval: 0 }, { freq: 'daily', interval: 1.5 }, { freq: 'weekly', weekdays: [7] }, { freq: 'weekly', weekdays: 'mon' }, { freq: 'daily', interval: 'x' }])
    assert.equal(validateRecurrence(bad), null, JSON.stringify(bad));
});
