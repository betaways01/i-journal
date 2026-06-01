import { sendMessage } from '../ai';
import { ConversationMessage } from '../types';
import {
  BootstrapDraft,
  BootstrapPatch,
  BootstrapRoutineProposal,
  BootstrapUnderstandingResult,
} from './types';
import { sectionsFromDiscreteLabels, parseTime } from '../bot/scenes/setup.helpers';

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function safeString(value: unknown, max = 120): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 120)));
}

function safeTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseTime(value);
  return parsed ?? undefined;
}

function extractDurableSetupDetails(text?: string): string[] {
  if (!text) return [];
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const facts: string[] = [];

  for (const line of lines) {
    if (/\b(wife|husband|kid|kids|child|children|family|hilda|tavana|reign|freelanc|prayer|church|fasting|ministry|word study|goal|improvement)\b/i.test(line)) {
      facts.push(line.replace(/\s+/g, ' ').slice(0, 180));
    }
  }

  return facts.slice(0, 8);
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

function normalizeRoutine(raw: unknown): BootstrapRoutineProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = safeString(obj.name);
  if (!name) return null;

  // Every routine is an AI-generated custom prompt now — there are no hardcoded routine
  // types, so the user can ask for any recurring message and we compose it fresh.
  return {
    kind: 'agent.custom_prompt',
    name,
    time: safeTime(obj.time),
    goal: safeString(obj.goal),
    prompt: safeString(obj.prompt, 500),
  };
}

export function normalizeBootstrapUnderstanding(raw: Record<string, unknown> | null): BootstrapUnderstandingResult {
  if (!raw) {
    return {
      assistantReply: "I missed that. Say it naturally again; I'll sort the structure out.",
      patch: {},
      confidence: 0,
      needsConfirmation: false,
      readyToComplete: false,
      missing: ['identity', 'areas', 'times'],
    };
  }

  const patchRaw = raw.patch && typeof raw.patch === 'object'
    ? (raw.patch as Record<string, unknown>)
    : {};
  const userRaw = patchRaw.userIdentity && typeof patchRaw.userIdentity === 'object'
    ? (patchRaw.userIdentity as Record<string, unknown>)
    : {};
  const agentRaw = patchRaw.agentIdentity && typeof patchRaw.agentIdentity === 'object'
    ? (patchRaw.agentIdentity as Record<string, unknown>)
    : {};

  const patch: BootstrapPatch = {
    userIdentity: {
      preferredName: safeString(userRaw.preferredName),
      givenName: safeString(userRaw.givenName),
      nicknames: safeStringArray(userRaw.nicknames),
      aliases: safeStringArray(userRaw.aliases),
      addressStyle: safeString(userRaw.addressStyle),
      rawMentions: safeStringArray(userRaw.rawMentions),
    },
    agentIdentity: {
      name: safeString(agentRaw.name),
      vibe: safeString(agentRaw.vibe),
      emoji: safeString(agentRaw.emoji),
    },
    areas: safeStringArray(patchRaw.areas),
    morningTime: safeTime(patchRaw.morningTime),
    eveningTime: safeTime(patchRaw.eveningTime),
    routineProposals: Array.isArray(patchRaw.routineProposals)
      ? patchRaw.routineProposals.map(normalizeRoutine).filter((r): r is NonNullable<typeof r> => Boolean(r))
      : [],
    notes: safeStringArray(patchRaw.notes),
  };

  const missingRaw = Array.isArray(raw.missing) ? raw.missing : [];
  const missing = missingRaw.filter(
    (item): item is 'identity' | 'areas' | 'times' =>
      item === 'identity' || item === 'areas' || item === 'times'
  );

  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5;

  return {
    assistantReply:
      safeString(raw.assistantReply, 900) ??
      "I'm following. Tell me a bit more and I'll shape the setup around you.",
    patch,
    confidence,
    needsConfirmation: raw.needsConfirmation === true,
    readyToComplete: raw.readyToComplete === true,
    missing,
  };
}

export function mergeBootstrapPatch(draft: BootstrapDraft, patch: BootstrapPatch, rawUserText?: string): BootstrapDraft {
  const next: BootstrapDraft = structuredClone(draft);
  const identity = patch.userIdentity ?? {};
  if (identity.preferredName) next.userIdentity.preferredName = identity.preferredName;
  if (identity.givenName) next.userIdentity.givenName = identity.givenName;
  if (identity.addressStyle) next.userIdentity.addressStyle = identity.addressStyle;
  next.userIdentity.nicknames = unique([...next.userIdentity.nicknames, ...(identity.nicknames ?? [])]);
  next.userIdentity.aliases = unique([...next.userIdentity.aliases, ...(identity.aliases ?? [])]);
  next.userIdentity.rawMentions = unique([
    ...next.userIdentity.rawMentions,
    ...(identity.rawMentions ?? []),
    ...(rawUserText ? [rawUserText] : []),
  ]).slice(-10);

  if (patch.agentIdentity?.name) next.agentIdentity.name = patch.agentIdentity.name;
  if (patch.agentIdentity?.vibe) next.agentIdentity.vibe = patch.agentIdentity.vibe;
  if (patch.agentIdentity?.emoji) next.agentIdentity.emoji = patch.agentIdentity.emoji;

  if (patch.areas && patch.areas.length > 0) {
    // Areas are whatever the user names — their words, not preset buckets. The AI already
    // returns them as discrete labels, so map each one straight to a section without
    // re-splitting on "and"/"/" (which would shred "Rest and recovery" into two areas).
    next.areas = sectionsFromDiscreteLabels([...next.areas.map((area) => area.title), ...patch.areas]);
  }

  if (patch.morningTime) next.morningTime = patch.morningTime;
  if (patch.eveningTime) next.eveningTime = patch.eveningTime;

  if (patch.routineProposals) {
    next.routineProposals = [...next.routineProposals, ...patch.routineProposals].slice(-5);
  }

  if (patch.notes) {
    next.notes = unique([...next.notes, ...patch.notes]).slice(-20);
  }
  next.notes = unique([...next.notes, ...extractDurableSetupDetails(rawUserText)]).slice(-20);

  return next;
}

const BOOTSTRAP_SCHEMA = `Return ONLY valid JSON with this shape:
{
  "assistantReply": "short natural Telegram reply",
  "patch": {
    "userIdentity": {
      "preferredName": "name to call the user, if clear",
      "givenName": "legal/given/common real name, if clear",
      "nicknames": ["nicknames user wants used"],
      "aliases": ["other names/handles user uses"],
      "addressStyle": "short preference",
      "rawMentions": ["raw identity phrase if relevant"]
    },
    "agentIdentity": {
      "name": "only if user is naming the bot/companion",
      "vibe": "only if user describes companion vibe",
      "emoji": "only if user chooses one"
    },
    "areas": ["life areas in the user's OWN words — optional, omit if none given"],
    "morningTime": "HH:MM if the user wants a morning check-in (optional)",
    "eveningTime": "HH:MM if the user wants an evening journal (optional)",
    "routineProposals": [
      {
        "name": "routine name",
        "time": "HH:MM if stated",
        "goal": "why they want it",
        "prompt": "what to generate and send each time"
      }
    ],
    "notes": ["small durable preferences"]
  },
  "confidence": 0.0,
  "needsConfirmation": true,
  "readyToComplete": false,
  "missing": ["identity", "areas", "times"]
}`;

export async function understandBootstrapTurn(params: {
  workspaceContext: string;
  draft: BootstrapDraft;
  history: ConversationMessage[];
  userMessage: string;
}): Promise<BootstrapUnderstandingResult> {
  const system = `You are i-Journal's bootstrap understanding agent.

Your job is to understand random human Telegram setup messages and turn them into structured patches.

Critical behavior:
- Do NOT enforce formats. Interpret natural language. Humans are random in what they want this for — never box them into a preset shape.
- Distinguish the user naming themselves from the user naming the companion.
- Distinguish preferred name, given name, nicknames, and aliases.
- Areas are whatever the user actually cares about — use THEIR words. Do NOT force them into preset buckets. "Woodworking", "Recovery", "My startup's metrics", "Mum's health", "Music" are all valid areas if that's what they say. A person may have one area, ten, or none.
- Keep area labels short (a word or short phrase). Put fine detail (specific people, ages, numbers, one-off facts) in notes, not in the area label.
- If user says "King Kang, or sometime Francis", infer preferredName "King Kang" and alias "Francis"; ask a light confirmation in assistantReply if uncertain.
- If user says "My name is Hilda but call me Hils", infer givenName "Hilda", preferredName "Hils", nicknames ["Hils"].
- If user says "Call yourself Nia", update agentIdentity.name, not userIdentity.
- If user says "Looks right, change your name to Frankie", treat it as a correction before completion: patch agentIdentity.name and set readyToComplete true, but do not say it was saved yet.
- Interpret times flexibly. "9.30" means 09:30 unless labeled evening/night, then 21:30 can be appropriate. "8.30 evening" means 20:30.
- Times and areas are OPTIONAL. Some people don't want scheduled check-ins or don't think in "areas" — that's fine. Patch only what they actually give; never demand them.
- The ONLY thing truly needed to finish setup is something to call them (a name). As soon as you know that, you may set readyToComplete true with a warm invitation to start. Do NOT interrogate for areas or times — they can be added later just by talking.
- Ask one natural next question at a time in assistantReply, and only if it genuinely helps.
- 'missing' should list ONLY genuinely-unknown essentials — at most 'identity' when you still don't have a name. Do NOT put 'areas' or 'times' in 'missing'; they are optional.
- Treat user-specific recurring wishes as routineProposals — ANY recurring message they want: motivation, scripture, business review, habit check, prayer nudge, language practice, family prompt, a weekly review, whatever. There are no fixed routine types; the runtime generates each one fresh from your wording.

Workspace context:
${params.workspaceContext}

Current draft:
${JSON.stringify(params.draft, null, 2)}

${BOOTSTRAP_SCHEMA}`;

  const response = await sendMessage(system, params.history, params.userMessage);
  return normalizeBootstrapUnderstanding(extractJsonObject(response));
}
