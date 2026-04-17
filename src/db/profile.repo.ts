import { getDb } from './index';
import { Profile, ProfileSection, DaySchedule, normalizeProfile, getDefaultProfile } from '../profile/defaults';

interface ProfileRow {
  user_id: number;
  name: string;
  sections_json: string;
  schedule_json: string;
  morning_time: string;
  evening_time: string;
  timezone: string;
  created_at: string;
  last_review_date: string | null;
  updated_at: string;
}

function rowToProfile(row: ProfileRow, onboardingComplete: boolean): Profile {
  return {
    name: row.name,
    sections: JSON.parse(row.sections_json) as ProfileSection[],
    schedule: JSON.parse(row.schedule_json) as Record<string, DaySchedule>,
    morningTime: row.morning_time,
    eveningTime: row.evening_time,
    timezone: row.timezone,
    onboardingComplete,
    createdAt: row.created_at.slice(0, 10),
    lastReviewDate: row.last_review_date ?? '',
  };
}

export function getProfileForUser(userId: number): Profile | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM profiles WHERE user_id = ?')
    .get(userId) as ProfileRow | undefined;
  if (!row) return null;

  const onboardingRow = db
    .prepare('SELECT onboarding_complete FROM users WHERE id = ?')
    .get(userId) as { onboarding_complete: number } | undefined;

  return rowToProfile(row, (onboardingRow?.onboarding_complete ?? 0) === 1);
}

export function saveProfileForUser(userId: number, profile: Profile): void {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(userId);

  if (existing) {
    db.prepare(
      `UPDATE profiles SET
        name = ?,
        sections_json = ?,
        schedule_json = ?,
        morning_time = ?,
        evening_time = ?,
        timezone = ?,
        last_review_date = ?,
        updated_at = ?
       WHERE user_id = ?`
    ).run(
      profile.name,
      JSON.stringify(profile.sections),
      JSON.stringify(profile.schedule),
      profile.morningTime,
      profile.eveningTime,
      profile.timezone,
      profile.lastReviewDate || null,
      now,
      userId
    );
  } else {
    db.prepare(
      `INSERT INTO profiles (
        user_id, name, sections_json, schedule_json,
        morning_time, evening_time, timezone,
        created_at, last_review_date, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      profile.name,
      JSON.stringify(profile.sections),
      JSON.stringify(profile.schedule),
      profile.morningTime,
      profile.eveningTime,
      profile.timezone,
      profile.createdAt || now.slice(0, 10),
      profile.lastReviewDate || null,
      now
    );
  }

  if (profile.onboardingComplete) {
    db.prepare('UPDATE users SET onboarding_complete = 1, updated_at = ? WHERE id = ?').run(
      now,
      userId
    );
  }
}

export function profileExistsForUser(userId: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(userId);
  return row !== undefined;
}

export function needsReviewForUser(userId: number): boolean {
  const profile = getProfileForUser(userId);
  if (!profile || !profile.lastReviewDate) return false;

  const last = new Date(profile.lastReviewDate);
  const diffDays = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 30;
}

export { normalizeProfile, getDefaultProfile };
