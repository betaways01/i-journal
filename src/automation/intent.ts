import { sendMessage } from '../ai';
import { UserRow } from '../db/users.repo';
import { getProfileForUser } from '../db/profile.repo';
import { Profile } from '../profile/defaults';
import { RoutineKind, RoutineSchedule } from '../routines/types';
import {
  fireAtFromCountdown,
  fireAtFromLocalDateTime,
  nextLocalFireAt,
  parseCountdownMinutes,
  parseFlexibleTime,
  parseIntervalEveryMinutes,
  parseWeekday,
} from './time';

export interface RoutineAutomationProposal {
  type: 'routine';
  kind: RoutineKind;
  name: string;
  schedule: RoutineSchedule;
  goal?: string;
  prompt: string;
  sourceText: string;
}

export interface ReminderAutomationProposal {
  type: 'reminder';
  kind: 'agent.custom_reminder';
  name: string;
  fireAtIso: string;
  timezone: string;
  message: string;
  sourceText: string;
}

export type AutomationProposal = RoutineAutomationProposal | ReminderAutomationProposal;

const AUTOMATION_SIGNAL_RE =
  /\b(remind|reminder|notify|timer|countdown|every|daily|weekly|routine|send me|ask me|check in|motivat|quote|teach me|prompt me)\b/i;
const EXPLICIT_AUTOMATION_SIGNAL_RE =
  /\b(remind|reminder|notify|timer|countdown|routine|send me|ask me|check in|motivat|quote|teach me|prompt me)\b/i;

function safeString(value: unknown, max = 180): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, max) : undefined;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate.trim()) return null;

  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function compactName(text: string, fallback: string): string {
  const cleaned = text
    .replace(/\b(please|kindly)\b/gi, '')
    .replace(/\b(can you|could you|i want you to|set up|create|make|add)\b/gi, '')
    .replace(/\b(remind me to|remind me|notify me to|notify me|send me|ask me to|ask me|teach me)\b/gi, '')
    .replace(/\b(every|daily|each day|per day|tomorrow|today|tonight|morning|evening|night)\b/gi, '')
    .replace(/\bin\s+\d{1,4}\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/gi, '')
    .replace(/\bat\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/^\s*to\s+/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();

  if (!cleaned) return fallback;
  const words = cleaned.split(/\s+/).slice(0, 5).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function reminderMessage(text: string): string {
  const cleaned = text
    .replace(/\b(please|kindly)\b/gi, '')
    .replace(/\b(remind me to|remind me|notify me to|notify me|tell me to|tell me)\b/gi, '')
    .replace(/\bin\s+\d{1,4}\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/gi, '')
    .replace(/\b(today|tomorrow|tonight)\b/gi, '')
    .replace(/\bat\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/^\s*to\s+/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  return cleaned ? `Reminder: ${cleaned}` : 'Reminder';
}

export function hasAutomationSignal(text: string): boolean {
  return AUTOMATION_SIGNAL_RE.test(text);
}

export function hasExplicitAutomationSignal(text: string): boolean {
  return EXPLICIT_AUTOMATION_SIGNAL_RE.test(text);
}

function inferDailyTime(text: string, profile: Profile): string {
  const explicit = parseFlexibleTime(text);
  if (explicit) return explicit;
  if (/\b(evening|night|tonight)\b/i.test(text)) return profile.eveningTime;
  return profile.morningTime;
}

function buildLocalProposal(text: string, profile: Profile): AutomationProposal | null {
  const lower = text.toLowerCase();
  const recurring =
    /\b(every|daily|each day|per day|weekly|routine)\b/.test(lower) &&
    /\b(send|ask|teach|remind|notify|prompt|check in|quote|motivat|message)\b/.test(lower);

  if (recurring) {
    const intervalMinutes = parseIntervalEveryMinutes(text);
    const weekday = parseWeekday(text);
    const time = inferDailyTime(text, profile);
    const schedule: RoutineSchedule = intervalMinutes
      ? { type: 'interval', everyMinutes: intervalMinutes, timezone: profile.timezone }
      : weekday !== null || /\bweekly\b/.test(lower)
        ? { type: 'weekly', dayOfWeek: weekday ?? 1, time, timezone: profile.timezone }
        : { type: 'daily', time, timezone: profile.timezone };

    return {
      type: 'routine',
      kind: 'agent.custom_prompt',
      name: compactName(text, 'Custom routine'),
      schedule,
      goal: text.trim().slice(0, 180),
      prompt: `The user asked for this recurring help: "${text.trim()}". Send one short, useful Telegram message when it runs.`,
      sourceText: text,
    };
  }

  if (/\b(remind|notify|timer|countdown)\b/i.test(text)) {
    const fireAt = nextLocalFireAt({ text, timezone: profile.timezone });
    if (!fireAt) return null;
    const message = reminderMessage(text);
    return {
      type: 'reminder',
      kind: 'agent.custom_reminder',
      name: compactName(text, 'Reminder'),
      fireAtIso: fireAt.toISOString(),
      timezone: profile.timezone,
      message,
      sourceText: text,
    };
  }

  return null;
}

function normalizeAiProposal(raw: Record<string, unknown> | null, text: string, profile: Profile): AutomationProposal | null {
  if (!raw) return null;
  const intent = safeString(raw.intent, 40);
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
  if (!intent || intent === 'none' || confidence < 0.35) return null;

  const name = safeString(raw.name, 80) ?? compactName(text, intent === 'reminder' ? 'Reminder' : 'Custom routine');
  const message = safeString(raw.message, 500) ?? reminderMessage(text);
  const prompt =
    safeString(raw.prompt, 700) ??
    `The user asked for this recurring help: "${text.trim()}". Send one short, useful Telegram message when it runs.`;

  if (intent === 'reminder') {
    const fireAtIso = safeString(raw.fireAtIso, 40);
    const countdownMinutes = typeof raw.countdownMinutes === 'number'
      ? Math.max(1, Math.round(raw.countdownMinutes))
      : null;
    const date = safeString(raw.date, 20);
    const time = safeString(raw.time, 10);
    const fireAt = fireAtIso && !Number.isNaN(Date.parse(fireAtIso))
      ? new Date(fireAtIso)
      : countdownMinutes
        ? fireAtFromCountdown(countdownMinutes)
        : date && time
          ? fireAtFromLocalDateTime({ date, time, timezone: profile.timezone })
          : nextLocalFireAt({ text, timezone: profile.timezone });
    if (!fireAt) return null;

    return {
      type: 'reminder',
      kind: 'agent.custom_reminder',
      name,
      fireAtIso: fireAt.toISOString(),
      timezone: profile.timezone,
      message,
      sourceText: text,
    };
  }

  if (intent !== 'routine') return null;

  const recurrence = safeString(raw.recurrence, 40) ?? 'daily';
  const intervalMinutes = typeof raw.intervalMinutes === 'number'
    ? Math.max(1, Math.round(raw.intervalMinutes))
    : parseIntervalEveryMinutes(text);
  const weekdayRaw = typeof raw.dayOfWeek === 'number' ? Math.round(raw.dayOfWeek) : parseWeekday(text);
  const time = safeString(raw.time, 10) ?? inferDailyTime(text, profile);

  const schedule: RoutineSchedule = recurrence === 'interval' && intervalMinutes
    ? { type: 'interval', everyMinutes: intervalMinutes, timezone: profile.timezone }
    : recurrence === 'weekly' || weekdayRaw !== null
      ? { type: 'weekly', dayOfWeek: weekdayRaw ?? 1, time, timezone: profile.timezone }
      : { type: 'daily', time, timezone: profile.timezone };

  return {
    type: 'routine',
    kind: 'agent.custom_prompt',
    name,
    schedule,
    goal: safeString(raw.goal, 180) ?? text.trim().slice(0, 180),
    prompt,
    sourceText: text,
  };
}

async function buildAiProposal(text: string, profile: Profile): Promise<AutomationProposal | null> {
  const localNow = new Date().toLocaleString('en-US', {
    timeZone: profile.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const system = `You are i-Journal's automation understanding gateway.

Turn a user's natural Telegram request into ONE safe automation proposal.

Supported execution tools:
- reminder: one-off countdown or date/time reminder. The app will send the reminder text later.
- routine: recurring message/check-in using agent.custom_prompt. The app will generate one short Telegram message each run.

Do not invent tools outside those capabilities. If the request is normal journaling, chatting, or impossible to schedule, return intent "none".
For reminders, prefer returning fireAtIso as an absolute ISO timestamp. Use the user's timezone and current local date/time.

Current local date/time for the user: ${localNow}
Timezone: ${profile.timezone}
Default morning time: ${profile.morningTime}
Default evening time: ${profile.eveningTime}
User areas: ${profile.sections.map((section) => section.title).join(', ') || 'none specified'}

Return ONLY valid JSON:
{
  "intent": "reminder" | "routine" | "none",
  "name": "short button label",
  "message": "for reminder: exact message to send",
  "prompt": "for routine: instruction for the recurring agent message",
  "goal": "short why, if useful",
  "recurrence": "once" | "daily" | "weekly" | "interval",
  "fireAtIso": "absolute ISO timestamp for reminders, if known",
  "date": "YYYY-MM-DD for one-off reminder if known",
  "time": "HH:MM in the user's timezone if known",
  "dayOfWeek": 0,
  "intervalMinutes": 60,
  "countdownMinutes": 30,
  "confidence": 0.0
}`;

  const response = await sendMessage(system, [], text);
  return normalizeAiProposal(extractJsonObject(response), text, profile);
}

export async function buildAutomationProposal(params: {
  userRow: UserRow;
  text: string;
}): Promise<AutomationProposal | null> {
  if (!hasAutomationSignal(params.text)) return null;

  const profile = getProfileForUser(params.userRow.id);
  if (!profile) return null;

  try {
    const ai = await buildAiProposal(params.text, profile);
    if (ai) return ai;
  } catch (err) {
    console.error('[AutomationGateway] AI proposal failed:', err);
  }

  return buildLocalProposal(params.text, profile);
}
