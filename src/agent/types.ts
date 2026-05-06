import { ProfileSection } from '../profile/defaults';

export type WorkspaceDocKey =
  | 'AGENTS.md'
  | 'SOUL.md'
  | 'TOOLS.md'
  | 'IDENTITY.md'
  | 'USER.md'
  | 'HEARTBEAT.md'
  | 'BOOTSTRAP.md'
  | 'MEMORY.md';

export interface WorkspaceDoc {
  userId: number;
  key: WorkspaceDocKey;
  content: string;
  updatedAt: string;
}

export interface UserIdentityDraft {
  preferredName?: string;
  givenName?: string;
  nicknames: string[];
  aliases: string[];
  addressStyle?: string;
  rawMentions: string[];
}

export interface AgentIdentityDraft {
  name?: string;
  vibe?: string;
  emoji?: string;
}

export interface BootstrapRoutineProposal {
  kind: 'learning.word_of_day' | 'agent.custom_prompt';
  name: string;
  time?: string;
  goal?: string;
  prompt?: string;
}

export interface BootstrapDraft {
  userIdentity: UserIdentityDraft;
  agentIdentity: AgentIdentityDraft;
  areas: ProfileSection[];
  morningTime?: string;
  eveningTime?: string;
  routineProposals: BootstrapRoutineProposal[];
  notes: string[];
}

export interface BootstrapPatch {
  userIdentity?: Partial<UserIdentityDraft>;
  agentIdentity?: Partial<AgentIdentityDraft>;
  areas?: string[];
  morningTime?: string;
  eveningTime?: string;
  routineProposals?: BootstrapRoutineProposal[];
  notes?: string[];
}

export interface BootstrapUnderstandingResult {
  assistantReply: string;
  patch: BootstrapPatch;
  confidence: number;
  needsConfirmation: boolean;
  readyToComplete: boolean;
  missing: Array<'identity' | 'areas' | 'times'>;
}
