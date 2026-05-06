import { UserRow } from '../db/users.repo';
import {
  ensureWorkspaceDocs,
  listWorkspaceDocs,
  upsertWorkspaceDoc,
} from '../db/agentWorkspace.repo';
import {
  AgentIdentityDraft,
  BootstrapDraft,
  UserIdentityDraft,
  WorkspaceDocKey,
} from './types';
import { formatAreas } from '../bot/scenes/setup.helpers';
import { Profile } from '../profile/defaults';

export const WORKSPACE_DOC_ORDER: WorkspaceDocKey[] = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
];

function defaultDocs(user: UserRow): Array<{ key: WorkspaceDocKey; content: string }> {
  const firstName = user.first_name || 'unknown';
  return [
    {
      key: 'AGENTS.md',
      content: `# AGENTS.md

## Operating Rules
- Understand messy human language before asking for formats.
- Separate understanding from committing changes: infer first, validate second, save only at a safe boundary.
- Ask for confirmation when identity, schedule, storage, or recurring behavior is ambiguous.
- Buttons are shortcuts, not cages. Free text is always allowed.
- Never pretend an integration exists. State storage and tool facts plainly.
- Prefer small, useful routines over grand plans.

## Autonomy
- The agent may propose new routines or actions when the user asks for recurring help.
- The agent may run registered i-Journal tools after confirmation or when a routine is already enabled.
- The agent must not run arbitrary server commands, external side effects, or new integrations that are not registered tools.
- If the user asks for a capability that is not available, propose the closest safe routine or say what is missing.`,
    },
    {
      key: 'SOUL.md',
      content: `# SOUL.md

You are a warm journal companion with practical memory. You are not a form, therapist, preacher, or productivity tyrant.

Be human, brief, adaptive, and concrete. Let the user's language lead. If faith appears, meet it naturally; do not force it.

Your job is to help the user feel accompanied while the system quietly keeps structure: profile, memory, routines, storage, and follow-through.`,
    },
    {
      key: 'IDENTITY.md',
      content: `# IDENTITY.md

Default agent name: i-Journal
Default vibe: warm, grounded, quietly capable
Default emoji: 🏆

The user may rename the companion. If they clearly name the bot rather than themselves, update this document, not USER.md.`,
    },
    {
      key: 'USER.md',
      content: `# USER.md

Telegram first name seen by system: ${firstName}
Preferred name: unknown
Given name: unknown
Nicknames: none yet
Aliases: none yet
Address style: natural and respectful
Timezone: unknown

This file is for who the user is and how to address them. It is not the agent identity.`,
    },
    {
      key: 'TOOLS.md',
      content: `# TOOLS.md

Available app capabilities:
- profile.update: save confirmed user profile details.
- agent_identity.update: save confirmed companion name/vibe.
- journal.morning_checkin: send morning check-in.
- journal.evening_reflection: run evening journal session.
- learning.word_of_day: send one practical word with meaning and example.
- agent.custom_prompt: send a recurring custom prompt/message generated from a safe instruction.
- storage.status: explain local SQLite and optional OneNote.
- storage.onenote: connect/test/disconnect OneNote through registered OAuth flows.

Unavailable:
- Arbitrary shell/server commands from user chat.
- External integrations unless explicitly implemented and configured.`,
    },
    {
      key: 'HEARTBEAT.md',
      content: `# HEARTBEAT.md

On background runs:
- Be brief.
- Respect active sessions.
- Run only enabled routines.
- Log run history.
- Do not surprise the user with new categories of behavior.`,
    },
    {
      key: 'BOOTSTRAP.md',
      content: `# BOOTSTRAP.md

Status: active

First-run ritual:
- Learn how to address the user, including preferred name, given name, nicknames, and aliases when offered.
- Notice if the user names the agent/companion separately from naming themselves.
- Learn a few life areas to keep in mind.
- Learn useful check-in times, accepting natural formats like "9.30", "8:30pm", "morning around nine".
- Offer simple helpful routines only when relevant.
- Complete setup once enough is known; do not demand rigid formats.`,
    },
    {
      key: 'MEMORY.md',
      content: `# MEMORY.md

No curated long-term memory yet.`,
    },
  ];
}

export function ensureAgentWorkspaceForUser(user: UserRow): void {
  ensureWorkspaceDocs(user.id, defaultDocs(user));
}

export function renderWorkspaceContext(userId: number, opts: { includeBootstrap: boolean }): string {
  const docs = listWorkspaceDocs(userId);
  const byKey = new Map(docs.map((doc) => [doc.key, doc.content]));
  const parts: string[] = [];

  for (const key of WORKSPACE_DOC_ORDER) {
    if (key === 'BOOTSTRAP.md' && !opts.includeBootstrap) continue;
    const content = byKey.get(key);
    if (!content?.trim()) continue;
    parts.push(`----- ${key} -----\n${content.trim()}`);
  }

  return parts.join('\n\n');
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none yet';
}

export function renderUserDocFromDraft(draft: BootstrapDraft, profile: Profile): string {
  const identity = draft.userIdentity;
  return `# USER.md

Preferred name: ${identity.preferredName || profile.name}
Given name: ${identity.givenName || 'unknown'}
Nicknames: ${list(identity.nicknames)}
Aliases: ${list(identity.aliases)}
Address style: ${identity.addressStyle || 'natural and respectful'}
Timezone: ${profile.timezone}

Life areas:
${formatAreas(profile.sections)}

Morning check-in: ${profile.morningTime}
Evening journal: ${profile.eveningTime}

Raw identity mentions:
${identity.rawMentions.length > 0 ? identity.rawMentions.map((m) => `- ${m}`).join('\n') : '- none recorded'}`;
}

export function renderIdentityDocFromDraft(identity: AgentIdentityDraft): string {
  return `# IDENTITY.md

Agent name: ${identity.name || 'i-Journal'}
Vibe: ${identity.vibe || 'warm, grounded, quietly capable'}
Emoji: ${identity.emoji || '🏆'}

The user may rename the companion. Keep this separate from USER.md.`;
}

export function markBootstrapComplete(userId: number): void {
  upsertWorkspaceDoc(
    userId,
    'BOOTSTRAP.md',
    `# BOOTSTRAP.md

Status: complete

The first-run ritual has finished. Future profile changes should go through natural understanding plus confirmation.`
  );
}

export function saveWorkspaceAfterBootstrap(userId: number, draft: BootstrapDraft, profile: Profile): void {
  upsertWorkspaceDoc(userId, 'USER.md', renderUserDocFromDraft(draft, profile));
  upsertWorkspaceDoc(userId, 'IDENTITY.md', renderIdentityDocFromDraft(draft.agentIdentity));
  markBootstrapComplete(userId);
}

export function emptyBootstrapDraft(): BootstrapDraft {
  return {
    userIdentity: {
      nicknames: [],
      aliases: [],
      rawMentions: [],
    },
    agentIdentity: {},
    areas: [],
    routineProposals: [],
    notes: [],
  };
}

export function hasEnoughForBootstrap(draft: BootstrapDraft): boolean {
  return Boolean(
    draft.userIdentity.preferredName &&
      draft.areas.length > 0 &&
      draft.morningTime &&
      draft.eveningTime
  );
}

export function preferredName(identity: UserIdentityDraft): string {
  return identity.preferredName || identity.givenName || identity.nicknames[0] || 'Friend';
}
