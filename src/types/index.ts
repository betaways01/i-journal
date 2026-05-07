export interface UserContext {
  telegramId: string;
  name: string;
  timezone: string;
  microsoftAccessToken: string;
  preferences: {
    morningTime: string; // "06:00"
    eveningTime: string; // "21:00"
  };
}

export interface JournalEntry {
  date: string; // "2026-03-26"
  dayOfWeek: string; // "Wednesday"
  sessionType: SessionType;
  sections: JournalSection[];
  ratings: Record<string, number>;
  closingLine?: string;
}

export interface JournalSection {
  key: string;
  emoji: string;
  title: string;
  content: string;
}

export type SessionType =
  | 'morning'
  | 'evening'
  | 'onboarding'
  | 'settings'
  | 'routine_setup'
  | 'automation_setup'
  | 'drop'
  | 'vent';

export type ConversationFlowName =
  | 'onboarding'
  | 'settings'
  | 'routine_setup'
  | 'automation_setup'
  | 'agent_action';

export interface ConversationFlowState {
  name: ConversationFlowName;
  step: string;
  data: Record<string, unknown>;
}

export interface ConversationState {
  userId: string;
  sessionType: SessionType;
  currentSectionIndex: number;
  collectedSections: JournalSection[];
  ratings: Record<string, number>;
  conversationHistory: ConversationMessage[];
  startedAt: Date;
  completed: boolean;
  flow?: ConversationFlowState;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}
