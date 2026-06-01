import { CompanionTool } from '../ai';
import { BotUser } from '../bot/userContext';
import {
  saveJournalEntry,
  markEntrySavedToCloud,
  getEntriesInDateRange,
} from '../db/entries.repo';
import {
  getOneNoteStatusForUser,
  writeMorningToOneNoteForUser,
  writeEveningToOneNoteForUser,
  getOneNoteTargetForUser,
  ensureOneNoteLocationForUser,
  createOneNotePageForUser,
} from '../onenote/writer';
import { mergeStorageMetadataForUser, upsertStorageConnectionForUser } from '../db/storageConnections.repo';
import { buildMicrosoftAuthUrlForUser } from '../onenote/auth';
import { hasMicrosoftOAuthConfigured } from '../config';
import { saveProfileForUser } from '../db/profile.repo';
import { Profile } from '../profile/defaults';
import { sectionsFromDiscreteLabels, parseTime, todayLocalDate } from '../bot/scenes/setup.helpers';
import { formatDateForJournal } from '../ai/prompts/dayConfig';
import { appendMemoryFacts, updateAgentIdentityForUser } from './workspace';
import { reloadScheduler } from '../scheduler';
import { scheduleReminder } from '../db/reminders.repo';
import { createRoutine } from '../db/routines.repo';
import { RoutineSchedule } from '../routines/types';
import { computeNextRunAt } from '../routines/schedule';
import { updateJournalState } from '../state/session.store';

export type EntryMode = 'morning' | 'evening' | 'drop';

export interface SavedEntryEffect {
  mode: EntryMode;
  markdown: string;
  streakDays: number;
  oneNoteUrl: string | null;
  oneNoteStatus: 'synced' | 'not_connected' | 'failed' | 'skipped';
  oneNoteError?: string;
  entryDate: string;
}

/**
 * Side effects the agent caused this turn that the scene needs to react to
 * (echo the entry, show the save confirmation, end the session, refresh schedule).
 * Everything else the agent simply narrates in its own reply.
 */
export interface SessionEffects {
  savedEntry?: SavedEntryEffect;
  scheduleChanged: boolean;
  profileChanged: boolean;
}

export interface CompanionToolDeps {
  botUser: BotUser;
  /** The mode of the active session, used as the default for save_journal_entry. */
  sessionMode: EntryMode;
  /** The date the entry should be filed under (today, or a catch-up date). */
  sessionDate: Date;
}

// Anchor on the most recent entry (today if it has one, else the latest entry date) and
// count consecutive days back. This mirrors the canonical streak in ai/memory.ts so a
// catch-up entry filed under an earlier day still reports a coherent streak.
function computeStreakDays(userId: number, timezone: string): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 60);
  const start = startDate.toLocaleDateString('en-CA', { timeZone: timezone });

  const entries = getEntriesInDateRange(userId, start, today);
  const dates = new Set(entries.map((e) => e.entry_date));
  if (dates.size === 0) return 0;

  const mostRecent = [...dates].sort().reverse()[0];
  const anchorStr = dates.has(today) ? today : mostRecent;

  let streak = 0;
  const cursor = new Date(anchorStr + 'T12:00:00Z');
  for (let i = 0; i < 60; i++) {
    const cursorStr = cursor.toLocaleDateString('en-CA', { timeZone: timezone });
    if (dates.has(cursorStr)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseWeekday(value: string | undefined): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const idx = WEEKDAYS.findIndex((d) => d.startsWith(v.slice(0, 3)));
  return idx >= 0 ? idx : null;
}

function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.type === 'daily') return `daily at ${schedule.time}`;
  if (schedule.type === 'weekly') {
    const day = WEEKDAYS[schedule.dayOfWeek];
    return `every ${day.charAt(0).toUpperCase() + day.slice(1)} at ${schedule.time}`;
  }
  const mins = schedule.everyMinutes;
  return mins % 60 === 0 ? `every ${mins / 60}h` : `every ${mins} min`;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function formatLocalTime(date: Date, timezone: string): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  });
}

async function runSaveJournalEntry(
  deps: CompanionToolDeps,
  effects: SessionEffects,
  input: Record<string, unknown>
): Promise<string> {
  const markdown = str(input, 'entry_markdown') ?? str(input, 'markdown');
  if (!markdown) {
    return 'Error: entry_markdown is required. Write the entry in the user\'s first-person voice and pass it.';
  }

  const requestedKind = str(input, 'kind');
  const mode: EntryMode =
    requestedKind === 'morning' || requestedKind === 'evening' || requestedKind === 'drop'
      ? requestedKind
      : deps.sessionMode;

  const { botUser, sessionDate } = deps;
  const timezone = botUser.profile.timezone;
  const { dateStr, dayStr } = formatDateForJournal(sessionDate, timezone);

  // Drops are free-floating, so give them a unique session_type to avoid clobbering
  // an existing morning/evening entry under the UNIQUE(user, date, type) constraint.
  const persistedSessionType: 'morning' | 'evening' | 'drop' =
    mode === 'drop' ? (`drop_${Date.now()}` as 'drop') : mode;

  const entryId = saveJournalEntry({
    userId: botUser.row.id,
    entryDate: dateStr,
    dayOfWeek: dayStr,
    sessionType: persistedSessionType,
    contentMarkdown: markdown,
  });

  if (mode === 'morning') {
    updateJournalState(String(botUser.row.telegram_id), { lastMorningDate: dateStr });
  } else if (mode === 'evening') {
    updateJournalState(String(botUser.row.telegram_id), { lastEveningDate: dateStr });
  }

  const streakDays = computeStreakDays(botUser.row.id, timezone);

  let oneNoteUrl: string | null = null;
  let oneNoteStatus: SavedEntryEffect['oneNoteStatus'] = 'not_connected';
  let oneNoteError: string | undefined;

  if (getOneNoteStatusForUser(botUser.row).connected) {
    try {
      oneNoteUrl =
        mode === 'morning'
          ? await writeMorningToOneNoteForUser(botUser.row, dateStr, dayStr, markdown)
          : await writeEveningToOneNoteForUser(botUser.row, dateStr, dayStr, markdown);
      if (oneNoteUrl) markEntrySavedToCloud(entryId, oneNoteUrl);
      else markEntrySavedToCloud(entryId, null);
      oneNoteStatus = 'synced';
    } catch (err) {
      oneNoteStatus = 'failed';
      oneNoteError = err instanceof Error ? err.message : String(err);
      console.error('[Tools] OneNote save failed:', oneNoteError);
    }
  }

  effects.savedEntry = {
    mode,
    markdown,
    streakDays,
    oneNoteUrl,
    oneNoteStatus,
    oneNoteError,
    entryDate: dateStr,
  };

  const oneNoteLine =
    oneNoteStatus === 'synced'
      ? 'Also synced to OneNote.'
      : oneNoteStatus === 'failed'
        ? 'Saved locally, but OneNote sync failed this time — the entry is safe. You may mention they can reconnect via /storage.'
        : 'Saved locally only (OneNote not connected).';

  return [
    `Entry saved for ${dateStr} (${mode}). Current streak: ${streakDays} day(s). ${oneNoteLine}`,
    'The entry text and a save confirmation are shown to the user automatically.',
    'Reply with only a short, warm closing line (one sentence) — do NOT repeat the entry.',
  ].join(' ');
}

function runRemember(deps: CompanionToolDeps, input: Record<string, unknown>): string {
  const fact = str(input, 'fact');
  if (!fact) return 'Error: fact is required.';
  appendMemoryFacts(deps.botUser.row.id, [fact]);
  return `Remembered: "${fact}". This is now durable across sessions.`;
}

function runSetReminder(deps: CompanionToolDeps, input: Record<string, unknown>): string {
  const message = str(input, 'message');
  if (!message) return 'Error: message is required (what to remind them about).';

  const timezone = deps.botUser.profile.timezone;
  const minutes = num(input, 'minutes_from_now');
  const atTime = str(input, 'at_time');

  let fireAt: Date;
  if (minutes !== undefined && minutes > 0) {
    fireAt = new Date(Date.now() + minutes * 60 * 1000);
  } else if (atTime) {
    const normalized = parseTime(atTime);
    if (!normalized) {
      return 'Error: could not understand the time. Ask the user for a clearer time or a number of minutes.';
    }
    fireAt = computeNextRunAt({ type: 'daily', time: normalized, timezone }, new Date());
  } else {
    return 'Error: provide either minutes_from_now or at_time.';
  }

  scheduleReminder({
    userId: deps.botUser.row.id,
    kind: 'agent.custom_reminder',
    fireAt,
    payload: { message },
  });

  return `Reminder set for ${formatLocalTime(fireAt, timezone)}: "${message}". It will fire even if the app restarts.`;
}

function runSetRoutine(deps: CompanionToolDeps, input: Record<string, unknown>): string {
  const name = str(input, 'name');
  const instruction = str(input, 'instruction');
  if (!name || !instruction) {
    return 'Error: name and instruction are required.';
  }

  const timezone = deps.botUser.profile.timezone;
  const everyMinutes = num(input, 'every_minutes') ?? (num(input, 'every_hours') ? num(input, 'every_hours')! * 60 : undefined);
  const cadence = str(input, 'cadence') ?? (everyMinutes ? 'interval' : 'daily');

  let schedule: RoutineSchedule;
  if (cadence === 'interval') {
    if (!everyMinutes || everyMinutes < 5) {
      return 'Error: interval routines need every_minutes (>= 5) or every_hours.';
    }
    schedule = { type: 'interval', everyMinutes: Math.round(everyMinutes), timezone };
  } else if (cadence === 'weekly') {
    const time = parseTime(str(input, 'time') ?? '');
    const weekday = parseWeekday(str(input, 'weekday'));
    if (!time) return 'Error: weekly routines need a time like "07:30".';
    if (weekday === null) return 'Error: weekly routines need a weekday (Monday..Sunday).';
    schedule = { type: 'weekly', dayOfWeek: weekday, time, timezone };
  } else {
    const time = parseTime(str(input, 'time') ?? '');
    if (!time) return 'Error: daily routines need a time like "07:30".';
    schedule = { type: 'daily', time, timezone };
  }

  createRoutine({
    userId: deps.botUser.row.id,
    kind: 'agent.custom_prompt',
    name,
    schedule,
    config: { prompt: instruction, goal: instruction },
    nextRunAt: computeNextRunAt(schedule, new Date()),
  });

  return `Routine "${name}" set — ${describeSchedule(schedule)} (${timezone}). I'll write it fresh each time, not from a script.`;
}

function runUpdateSchedule(
  deps: CompanionToolDeps,
  effects: SessionEffects,
  input: Record<string, unknown>
): string {
  const morning = str(input, 'morning_time');
  const evening = str(input, 'evening_time');
  const morningTime = morning ? parseTime(morning) : null;
  const eveningTime = evening ? parseTime(evening) : null;

  if (!morningTime && !eveningTime) {
    return 'Error: provide morning_time and/or evening_time (e.g. "07:00", "9pm").';
  }

  const profile = deps.botUser.profile;
  const updated: Profile = {
    ...profile,
    morningTime: morningTime ?? profile.morningTime,
    eveningTime: eveningTime ?? profile.eveningTime,
    lastReviewDate: todayLocalDate(profile.timezone),
    onboardingComplete: true,
  };
  saveProfileForUser(deps.botUser.row.id, updated);
  deps.botUser.profile = updated;
  effects.scheduleChanged = true;
  reloadScheduler();

  const parts: string[] = [];
  if (morningTime) parts.push(`morning check-in → ${morningTime}`);
  if (eveningTime) parts.push(`evening journal → ${eveningTime}`);
  return `Schedule updated: ${parts.join(', ')}. Scheduler reloaded.`;
}

function runUpdateProfile(
  deps: CompanionToolDeps,
  effects: SessionEffects,
  input: Record<string, unknown>
): string {
  const name = str(input, 'name');
  const addAreasRaw = input['add_areas'];
  const addAreas = Array.isArray(addAreasRaw)
    ? addAreasRaw.filter((a): a is string => typeof a === 'string')
    : typeof addAreasRaw === 'string'
      ? [addAreasRaw]
      : [];

  if (!name && addAreas.length === 0) {
    return 'Error: provide a name and/or add_areas.';
  }

  const profile = deps.botUser.profile;
  const changes: string[] = [];

  const next: Profile = { ...profile, sections: [...profile.sections] };

  if (name) {
    next.name = name;
    changes.push(`name → ${name}`);
  }

  if (addAreas.length > 0) {
    const newSections = sectionsFromDiscreteLabels(addAreas);
    const existingKeys = new Set(next.sections.map((s) => s.key));
    const added = newSections.filter((s) => !existingKeys.has(s.key));
    next.sections = [...next.sections, ...added].slice(0, 8);
    if (added.length) changes.push(`areas + ${added.map((s) => s.title).join(', ')}`);
  }

  if (changes.length === 0) return 'No changes were needed (already up to date).';

  next.lastReviewDate = todayLocalDate(profile.timezone);
  next.onboardingComplete = true;
  saveProfileForUser(deps.botUser.row.id, next);
  deps.botUser.profile = next;
  effects.profileChanged = true;

  return `Profile updated: ${changes.join('; ')}.`;
}

function runRenameCompanion(deps: CompanionToolDeps, input: Record<string, unknown>): string {
  const name = str(input, 'name');
  if (!name) return 'Error: name is required.';
  const identity = updateAgentIdentityForUser(deps.botUser.row.id, { name });
  return `Done — your companion is now named "${identity.name}".`;
}

async function runSetOneNoteLocation(deps: CompanionToolDeps, input: Record<string, unknown>): Promise<string> {
  const notebook = str(input, 'notebook');
  const section = str(input, 'section');
  if (!notebook && !section) {
    return 'Error: provide a notebook and/or section name.';
  }
  if (!getOneNoteStatusForUser(deps.botUser.row).connected) {
    return 'OneNote is not connected for this account yet — connect it from /storage first, then I can set the notebook/section.';
  }

  const prev = getOneNoteTargetForUser(deps.botUser.row);
  const patch: Record<string, unknown> = {};
  if (notebook) patch.notebook = notebook;
  if (section) patch.section = section;

  // Persist on the connection metadata. For a legacy env-token owner with no stored row,
  // create a metadata-only row (no tokens — auth still uses the env tokens) so their location
  // is remembered too. This works for every connected user, not just OAuth ones.
  const updated =
    mergeStorageMetadataForUser(deps.botUser.row.id, 'onenote', patch) ??
    upsertStorageConnectionForUser({ userId: deps.botUser.row.id, provider: 'onenote', metadata: patch });
  if (!updated) {
    return "Couldn't set the location right now. Try reconnecting OneNote from /storage.";
  }

  // Validate + provision the chosen notebook/section. If it can't be reached, revert so we
  // never leave a broken target behind.
  try {
    const target = await ensureOneNoteLocationForUser(deps.botUser.row);
    return `OneNote location set: notebook "${target.notebook}" → section "${target.section}". Entries and pages will go there now.`;
  } catch (err) {
    mergeStorageMetadataForUser(deps.botUser.row.id, 'onenote', {
      notebook: prev.notebook,
      section: prev.section,
    });
    const msg = err instanceof Error ? err.message : String(err);
    return `Couldn't set that OneNote location: ${msg}`;
  }
}

async function runCreateOneNotePage(deps: CompanionToolDeps, input: Record<string, unknown>): Promise<string> {
  const content = str(input, 'content');
  if (!content) return 'Error: content is required — what should the page say?';
  const title = str(input, 'title') ?? 'Note';
  if (!getOneNoteStatusForUser(deps.botUser.row).connected) {
    return 'OneNote is not connected for this account yet — connect it from /storage first.';
  }

  const url = await createOneNotePageForUser(deps.botUser.row, title, content);
  const target = getOneNoteTargetForUser(deps.botUser.row);
  return `Created OneNote page "${title}" in "${target.notebook}" → "${target.section}".${url ? ` Link: ${url}` : ''}`;
}

function runOneNoteStatus(deps: CompanionToolDeps): string {
  const status = getOneNoteStatusForUser(deps.botUser.row);
  if (status.connected) {
    const who = status.profileName ? ` (connected as ${status.profileName})` : '';
    const target = getOneNoteTargetForUser(deps.botUser.row);
    return `OneNote is connected${who}. Saving to notebook "${target.notebook}" → section "${target.section}". Morning/evening entries sync automatically; ask me anytime to change the notebook or section.`;
  }
  if (hasMicrosoftOAuthConfigured()) {
    let link: string;
    try {
      link = buildMicrosoftAuthUrlForUser(deps.botUser.row.id);
    } catch {
      link = '';
    }
    return link
      ? `OneNote is NOT connected. The user can connect it here: ${link} (or via /storage). Entries are still saved locally.`
      : 'OneNote is NOT connected. Ask them to run /storage to connect. Entries are saved locally meanwhile.';
  }
  return 'OneNote is not available on this server. Entries are saved in the local database only. Do not promise OneNote sync.';
}

function runLookUpEntries(deps: CompanionToolDeps, input: Record<string, unknown>): string {
  const daysBack = Math.min(Math.max(num(input, 'days_back') ?? 7, 1), 60);
  const timezone = deps.botUser.profile.timezone;
  const end = todayLocalDate(timezone);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);
  const start = startDate.toLocaleDateString('en-CA', { timeZone: timezone });

  const entries = getEntriesInDateRange(deps.botUser.row.id, start, end);
  if (entries.length === 0) {
    return `No entries found in the last ${daysBack} days.`;
  }

  const lines = entries
    .slice(-12)
    .map((e) => {
      const snippet = e.content_markdown
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .join(' ')
        .slice(0, 220);
      return `${e.entry_date} (${e.day_of_week}): ${snippet}`;
    });

  return `Entries in the last ${daysBack} days (most recent last):\n${lines.join('\n')}`;
}

/**
 * Build the companion's toolset bound to this user/session, plus a mutable effects
 * object the scene reads after the agent loop finishes.
 */
export function buildCompanionTools(deps: CompanionToolDeps): {
  tools: CompanionTool[];
  effects: SessionEffects;
} {
  const effects: SessionEffects = { scheduleChanged: false, profileChanged: false };

  const tools: CompanionTool[] = [
    {
      definition: {
        name: 'save_journal_entry',
        description:
          "Save the user's journal entry. Call this when the conversation has captured the day (or they wind down, say goodnight, say \"that's it\", or tap done). Write the entry yourself in their FIRST-PERSON voice, lightly organized, honest and compact — short is fine if they said little. This saves to the database and syncs to OneNote when connected. Always use this to save; never just claim an entry was saved.",
        input_schema: {
          type: 'object',
          properties: {
            entry_markdown: {
              type: 'string',
              description:
                "The journal entry in the user's first-person voice, as markdown. Start with a heading line like '## 🌙 Evening' / '## ☀️ Morning' / '## 📝 Note'. 2–6 short paragraphs; skip life areas nothing happened in.",
            },
            kind: {
              type: 'string',
              enum: ['morning', 'evening', 'drop'],
              description: 'Optional. Defaults to the current session type.',
            },
          },
          required: ['entry_markdown'],
        },
      },
      run: (input) => runSaveJournalEntry(deps, effects, input),
    },
    {
      definition: {
        name: 'remember',
        description:
          'Store a durable fact about the user or their life (a person, project, preference, weak spot, recurring thing) so you recall it in future sessions. Use whenever they share something worth remembering or ask you to remember it.',
        input_schema: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: 'The fact to remember, phrased concisely.' },
          },
          required: ['fact'],
        },
      },
      run: async (input) => runRemember(deps, input),
    },
    {
      definition: {
        name: 'set_reminder',
        description:
          'Schedule a one-off reminder message to be sent to the user later. Use for "remind me to…" requests. Provide either minutes_from_now or at_time.',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The reminder text to send them.' },
            minutes_from_now: { type: 'number', description: 'Fire this many minutes from now.' },
            at_time: { type: 'string', description: 'A clock time like "18:30" or "6pm" (next occurrence).' },
          },
          required: ['message'],
        },
      },
      run: async (input) => runSetReminder(deps, input),
    },
    {
      definition: {
        name: 'set_routine',
        description:
          'Create a recurring message of ANY cadence — daily, a specific weekday, or every N minutes/hours. Use for anything the user wants on a rhythm: morning motivation, a scripture each dawn, a Friday week-review, a habit check every few hours, a daily word, a Monday family-call nudge — whatever they ask for. You generate the content FRESH from the instruction each time (never a canned script).',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short routine name.' },
            instruction: { type: 'string', description: 'What to generate and send each time, in your own words.' },
            cadence: {
              type: 'string',
              enum: ['daily', 'weekly', 'interval'],
              description: 'daily (every day at a time), weekly (a weekday at a time), or interval (every N minutes/hours). Defaults to daily, or interval if every_minutes/every_hours is given.',
            },
            time: { type: 'string', description: 'For daily/weekly: time like "07:00" or "8am".' },
            weekday: { type: 'string', description: 'For weekly: Monday..Sunday.' },
            every_minutes: { type: 'number', description: 'For interval: minutes between sends (>= 5).' },
            every_hours: { type: 'number', description: 'For interval: hours between sends (alternative to every_minutes).' },
          },
          required: ['name', 'instruction'],
        },
      },
      run: async (input) => runSetRoutine(deps, input),
    },
    {
      definition: {
        name: 'update_schedule',
        description:
          "Change the user's daily check-in times. Use for 'move my morning to 7', 'journal at 10pm', etc.",
        input_schema: {
          type: 'object',
          properties: {
            morning_time: { type: 'string', description: 'New morning check-in time.' },
            evening_time: { type: 'string', description: 'New evening journal time.' },
          },
        },
      },
      run: async (input) => runUpdateSchedule(deps, effects, input),
    },
    {
      definition: {
        name: 'update_profile',
        description:
          "Update the user's display name and/or add life areas you track. Use for 'call me X' or 'also track my health/finances'.",
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'New name to call the user.' },
            add_areas: {
              type: 'array',
              items: { type: 'string' },
              description: 'Life areas to start tracking, e.g. ["Health", "Finances"].',
            },
          },
        },
      },
      run: async (input) => runUpdateProfile(deps, effects, input),
    },
    {
      definition: {
        name: 'rename_companion',
        description:
          'Rename yourself (the companion) when the user gives you a name or asks you to go by something.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The new companion name.' },
          },
          required: ['name'],
        },
      },
      run: async (input) => runRenameCompanion(deps, input),
    },
    {
      definition: {
        name: 'onenote_status',
        description:
          'Check whether OneNote backup is connected, and get a connect link if not. Use this before telling the user anything about OneNote so you never guess.',
        input_schema: { type: 'object', properties: {} },
      },
      run: async () => runOneNoteStatus(deps),
    },
    {
      definition: {
        name: 'set_onenote_location',
        description:
          "Choose WHICH OneNote notebook and section the journal saves into — e.g. \"journal into my 'mygreatlifestyle' notebook, section 'i-journal'\". Creates them if they don't exist. The user's own words, not a fixed location. Requires OneNote connected.",
        input_schema: {
          type: 'object',
          properties: {
            notebook: { type: 'string', description: 'Notebook name to use or create.' },
            section: { type: 'string', description: 'Section name to use or create.' },
          },
        },
      },
      run: (input) => runSetOneNoteLocation(deps, input),
    },
    {
      definition: {
        name: 'create_onenote_page',
        description:
          "Create a OneNote page with a title and content in the user's current notebook/section. Use for explicit requests like \"create a test page with something interesting\" or to drop a specific note into OneNote (this is separate from saving a journal entry). Requires OneNote connected.",
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Page title.' },
            content: { type: 'string', description: 'Page body. Markdown is fine.' },
          },
          required: ['content'],
        },
      },
      run: (input) => runCreateOneNotePage(deps, input),
    },
    {
      definition: {
        name: 'look_up_entries',
        description:
          "Look up the user's recent journal entries when they ask what they wrote, or when you want to reference something specific from earlier days.",
        input_schema: {
          type: 'object',
          properties: {
            days_back: { type: 'number', description: 'How many days back to look (default 7, max 60).' },
          },
        },
      },
      run: async (input) => runLookUpEntries(deps, input),
    },
  ];

  return { tools, effects };
}
