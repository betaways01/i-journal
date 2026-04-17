import fs from 'fs';
import path from 'path';
import { upsertUser } from './users.repo';
import { saveProfileForUser, profileExistsForUser } from './profile.repo';
import { updateJournalStateForUser, getJournalStateForUser } from './journalState.repo';
import { getDefaultProfile, normalizeProfile, Profile } from '../profile/defaults';
import { config } from '../config';

const PROFILE_FILE = path.join(__dirname, '../../state/profile.json');
const STATE_FILE = path.join(__dirname, '../../state/journal.state.json');

export function migrateLegacyJsonIfPresent(): void {
  const ownerId = config.telegram.ownerId;
  if (!ownerId) return;

  const hasLegacyProfile = fs.existsSync(PROFILE_FILE);
  const hasLegacyState = fs.existsSync(STATE_FILE);
  if (!hasLegacyProfile && !hasLegacyState) return;

  const owner = upsertUser({ telegramId: ownerId, isOwner: true });

  if (hasLegacyProfile && !profileExistsForUser(owner.id)) {
    try {
      const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
      const normalized = normalizeProfile(raw);
      const defaults = getDefaultProfile();
      const merged: Profile = {
        ...defaults,
        ...raw,
        ...normalized,
        timezone: raw.timezone || config.timezone || defaults.timezone,
        onboardingComplete: raw.onboardingComplete ?? true,
        createdAt: raw.createdAt || new Date().toISOString().slice(0, 10),
        lastReviewDate: raw.lastReviewDate || '',
      };
      saveProfileForUser(owner.id, merged);
      console.log(`[Migrate] Imported legacy profile for owner ${ownerId}`);
    } catch (err) {
      console.error('[Migrate] Failed to import legacy profile:', err);
    }
  }

  if (hasLegacyState) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const current = getJournalStateForUser(owner.id);
      if (!current.lastMorningDate && !current.lastEveningDate) {
        updateJournalStateForUser(owner.id, {
          lastMorningDate: raw.lastMorningDate ?? null,
          lastEveningDate: raw.lastEveningDate ?? null,
        });
        console.log(`[Migrate] Imported legacy journal state for owner ${ownerId}`);
      }
    } catch (err) {
      console.error('[Migrate] Failed to import legacy journal state:', err);
    }
  }
}
