/**
 * Core harness contracts.
 *
 * One loop: see -> think (model) -> tools -> observe -> speak.
 * The model decides. Tools enforce the few real invariants and report the truth.
 * Nothing in the core routes, rewrites, or answers by pattern-matching the user's words.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. The loop parses and validates. */
  arguments: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  /** Parts are only used on user messages that carry images. */
  content: string | ContentPart[];
  /** assistant only */
  tool_calls?: ToolCall[];
  /** tool only */
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema, root type object. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** 'none' forces a text answer even when tools are supplied. Default 'auto'. */
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Called with the visible assistant text accumulated so far (never reasoning). */
  onText?: (full: string) => void;
  /** Label for logs/usage accounting. */
  purpose?: 'turn' | 'summary' | 'task';
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  model: string;
  provider: string;
  /** Number of HTTP attempts across retries and fallbacks. */
  attempts: number;
}

export interface ModelClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** True when the active primary provider accepts image parts. */
  supportsImages(): boolean;
}

/** Thrown by a ModelClient when every provider and retry is exhausted. */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    public readonly causes: string[] = []
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export type MediaKind =
  | 'photo'
  | 'voice'
  | 'audio'
  | 'video'
  | 'video_note'
  | 'document'
  | 'sticker'
  | 'animation';

export interface InboundMedia {
  kind: MediaKind;
  fileId?: string;
  mime?: string;
  duration?: number;
  fileName?: string;
  /** Absolute path on local disk once the gateway has downloaded it. */
  localPath?: string;
  /** Sticker emoji, when Telegram provides one. */
  emoji?: string;
}

export interface InboundTarget {
  messageId?: number;
  text?: string;
  quote?: string;
  media: InboundMedia[];
  /** True when the replied-to message was sent by the bot. */
  fromBot?: boolean;
}

export interface Inbound {
  /**
   * message   - a human message
   * button    - a human tapped an inline button (label in `text`)
   * scheduled - a scheduled task the human asked for is firing (instruction in `text`). No human is typing.
   * nudge     - the harness itself is prompting (e.g. journal still open late). No human is typing.
   */
  kind: 'message' | 'button' | 'scheduled' | 'nudge';
  messageId?: number;
  /** Text or caption. */
  text?: string;
  media: InboundMedia[];
  /** The message being replied to (swipe-reply). */
  target?: InboundTarget;
  forwarded?: boolean;
  /** Filled by the gateway when speech-to-text succeeded. */
  transcript?: string;
  /** Set when a voice/audio/video_note arrived but could not be transcribed. Human-readable reason. */
  transcriptMiss?: string;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface JournalEntry {
  id: number;
  /** ISO instant the entry was written. */
  at: string;
  /** HH:mm in the user's timezone at write time. */
  localTime: string;
  text: string;
  media: InboundMedia[];
}

export interface JournalDay {
  /** YYYY-MM-DD in the user's timezone. */
  date: string;
  weekday: string;
  entries: JournalEntry[];
  /** Written by the model at wrap, only from the day's entries. */
  reflection?: string;
  closedAt?: string;
  updatedAt: string;
  /** Bumped on every change. Dirty for sync when rev > syncedRev. */
  rev: number;
  syncedRev: number;
  /** Last successful remote sync. */
  syncedAt?: string;
  remotePageId?: string;
  remoteUrl?: string;
}

export interface JournalHit {
  date: string;
  weekday: string;
  entryId: number;
  localTime: string;
  snippet: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface Profile {
  /** What they want to be called. Empty until they say. */
  name: string;
  /** A name they gave the companion. Empty until they give one. */
  agentName: string;
  timezone: string;
}

export type FactKind = 'fact' | 'instruction';

export interface Fact {
  id: number;
  /** fact: something about them or their world. instruction: a standing instruction for how the companion should behave. */
  kind: FactKind;
  text: string;
  createdAt: string;
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Notes (library)
// ---------------------------------------------------------------------------

export interface Note {
  id: number;
  notebook: string;
  section: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  rev: number;
  syncedRev: number;
  syncedAt?: string;
  remotePageId?: string;
  remoteUrl?: string;
}

export interface NoteHit {
  /** 'local:<id>' for notes stored here, 'remote:<id>' for the remote library. */
  ref: string;
  /** Notebook / Section / Title */
  path: string;
  snippet: string;
  /** YYYY-MM-DD when known. */
  date?: string;
  url?: string;
  score?: number;
}

// ---------------------------------------------------------------------------
// Reminders and scheduled tasks
// ---------------------------------------------------------------------------

export interface Recurrence {
  freq: 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  /** Every N units. >= 1. */
  interval: number;
  /** For weekly: 0=Sunday .. 6=Saturday. Empty means the weekday of the first fire time. */
  weekdays?: number[];
}

export interface Reminder {
  id: number;
  userKey: string;
  /** notify: deliver `text` as-is. task: run a model turn with `text` as the instruction and deliver its reply. */
  kind: 'notify' | 'task';
  text: string;
  /** ISO instant (UTC) of the next fire. */
  fireAt: string;
  recurrence?: Recurrence;
  status: 'pending' | 'done' | 'cancelled';
  createdAt: string;
  lastFiredAt?: string;
  /** Consecutive failed delivery attempts for the current occurrence. */
  attempts: number;
  /** When a failed delivery will be retried. fireAt keeps the scheduled time. */
  retryAt?: string;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** ISO instant. */
  at: string;
  /** Media that accompanied a user message (for re-attaching recent photos). */
  media?: InboundMedia[];
  /** message | button | scheduled | nudge | delivered (a reminder/notice the gateway sent outside a turn). */
  origin?: string;
}

export type NewMessage = Omit<StoredMessage, 'id'>;

// ---------------------------------------------------------------------------
// Per-user state
// ---------------------------------------------------------------------------

export interface UndoRecord {
  kind: 'journal_entry' | 'note' | 'fact' | 'reminder' | 'journal_close';
  /** Entry id, note id, fact id, reminder id, or date. */
  ref: string;
  /** For journal entries: the date of the page. */
  date?: string;
  at: string;
  label: string;
  /** JSON of whatever is needed to reverse the action (previous note body, removed fact, previous reflection). */
  prev?: string;
}

export interface PendingOffer {
  text: string;
  date: string;
  at: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** One line shown on the button message, e.g. 'Save the skill "live-currency-rates"'. */
  label: string;
  createdAt: string;
}

export interface UserState {
  journalOpen: boolean;
  journalOpenedAt?: string;
  /** The date the open session is writing to. Lets a session that crosses midnight stay on its day. */
  journalDate?: string;
  /** A life dump the companion offered to put on the page while the journal was closed. */
  pendingOffer?: PendingOffer;
  /** Most recent first. Bounded. */
  undo: UndoRecord[];
  /** Rolling summary of conversation older than the verbatim window. */
  summary: string;
  /** Highest message id folded into `summary`. */
  summaryThrough: number;
  /** YYYY-MM-DD of the last "journal still open" nudge. */
  nudgedOn?: string;
  /** Note paths that searches returned recently. A reply may cite these. Bounded. */
  cited?: string[];
  /** Writes waiting for the person's one-tap approval (from turns that included web or forwarded content). */
  approvals?: PendingApproval[];
  /** Token use per local day, for the daily cap and /health. Last 14 days. */
  usage?: Record<string, { prompt: number; completion: number; turns: number }>;
  /** YYYY-MM-DD the memory tidy last ran. */
  tidiedOn?: string;
  /** Version of the app the owner was last told about (deploy notice). */
  noticedVersion?: string;
  /** Reactions they put on replies since the last turn; shown once, then cleared. */
  feedback?: Array<{ emoji: string; score: number; at: string; excerpt?: string }>;
  turnCount: number;
  /** Set once the legacy person-mem file for this user has been imported. */
  importedLegacyAt?: string;
  /** Set once the original companion's SQLite data for this user has been imported. */
  importedLegacyDbAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

// ---------------------------------------------------------------------------
// Turn log (for improving the app)
// ---------------------------------------------------------------------------

export interface TurnToolLog {
  tool: string;
  ok: boolean;
  ms: number;
  /** Arguments as JSON, shortened. */
  args?: string;
  /** First line of the result when the tool failed. */
  error?: string;
}

export interface TurnRecord {
  id: number;
  userKey: string;
  at: string;
  kind: string;
  ms: number;
  rounds: number;
  tools: TurnToolLog[];
  corrections: string[];
  effects: string[];
  degraded?: string;
  silent: boolean;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  replyChars: number;
  error?: string;
  /** Reaction the person put on the reply, and its sign (+1 / -1 / 0). */
  feedback?: string;
  feedbackScore?: number;
}

export interface IssueRecord {
  id: number;
  userKey: string;
  at: string;
  turnId?: number;
  /** 'missing_capability' | 'tool_failed' | 'complaint' | … */
  kind: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface Store {
  // profile + state
  getProfile(userKey: string): Profile;
  saveProfile(userKey: string, profile: Profile): void;
  getState(userKey: string): UserState;
  saveState(userKey: string, state: UserState): void;

  // facts
  listFacts(userKey: string): Fact[];
  /** Returns the existing fact when the same text (case-insensitive) is already stored. */
  addFact(userKey: string, kind: FactKind, text: string, now: Date): { fact: Fact; created: boolean };
  removeFact(userKey: string, id: number): Fact | null;
  restoreFact(userKey: string, fact: Fact): void;

  // skills
  listSkills(userKey: string): Skill[];
  getSkill(userKey: string, name: string): Skill | null;
  saveSkill(userKey: string, skill: Omit<Skill, 'updatedAt'>, now: Date): Skill;
  removeSkill(userKey: string, name: string): boolean;

  // journal
  getDay(userKey: string, date: string): JournalDay | null;
  /** Dates with at least one entry, newest first. */
  listDays(userKey: string, opts?: { from?: string; to?: string; limit?: number }): Array<{ date: string; weekday: string; entries: number; closed: boolean }>;
  addEntry(userKey: string, date: string, entry: { text: string; media: InboundMedia[]; at: Date; localTime: string }): { day: JournalDay; entry: JournalEntry };
  removeEntry(userKey: string, date: string, entryId: number): JournalEntry | null;
  setReflection(userKey: string, date: string, reflection: string | undefined, closedAt: Date | undefined): JournalDay | null;
  /** `rev` is the revision that was rendered and sent; defaults to the current one. */
  markDaySynced(userKey: string, date: string, info: { at: Date; rev?: number; remotePageId?: string; remoteUrl?: string }): void;
  /** Days whose content changed since the last successful sync, oldest first. */
  dirtyDays(userKey: string): JournalDay[];
  searchJournal(userKey: string, query: string, opts?: { from?: string; to?: string; limit?: number }): JournalHit[];

  // notes
  saveNote(userKey: string, note: { notebook: string; section: string; title: string; body: string }, now: Date): { note: Note; created: boolean };
  getNote(userKey: string, id: number): Note | null;
  /** Case-insensitive lookup by Notebook / Section / Title. */
  findNote(userKey: string, notebook: string, section: string, title: string): Note | null;
  removeNote(userKey: string, id: number): Note | null;
  searchNotes(userKey: string, query: string, limit?: number): NoteHit[];
  listNotebooks(userKey: string): Array<{ notebook: string; section: string; notes: number }>;
  markNoteSynced(userKey: string, id: number, info: { at: Date; rev?: number; remotePageId?: string; remoteUrl?: string }): void;
  /** Restores a previous body (undo of an update). */
  setNoteBody(userKey: string, id: number, body: string, now: Date): Note | null;
  dirtyNotes(userKey: string): Note[];

  // conversation
  appendMessages(userKey: string, messages: NewMessage[]): StoredMessage[];
  /** Messages with id > afterId, oldest first. */
  messagesAfter(userKey: string, afterId: number, limit?: number): StoredMessage[];
  /** The newest `limit` messages, oldest first. */
  recentMessages(userKey: string, limit: number): StoredMessage[];
  countMessages(userKey: string): number;
  clearConversation(userKey: string): void;

  // reminders
  addReminder(userKey: string, r: { kind: Reminder['kind']; text: string; fireAt: Date; recurrence?: Recurrence }, now: Date): Reminder;
  getReminder(userKey: string, id: number): Reminder | null;
  listReminders(userKey: string, opts?: { includeFinished?: boolean }): Reminder[];
  cancelReminder(userKey: string, id: number): Reminder | null;
  restoreReminder(userKey: string, id: number): Reminder | null;
  /** Pending reminders across all users whose fireAt <= now, oldest first. */
  dueReminders(now: Date, limit?: number): Reminder[];
  /** After a successful delivery: one-shot -> done; recurring -> fireAt moves to `next`. Resets attempts. */
  completeOccurrence(id: number, firedAt: Date, next: Date | null): void;
  /** After a failed delivery: increments attempts and sets retryAt. fireAt (the schedule) is untouched. */
  deferOccurrence(id: number, retryAt: Date): void;

  /** Every user key that has any state. */
  listUserKeys(): string[];

  // conversation search
  searchMessages(userKey: string, query: string, limit?: number): Array<{ id: number; role: string; at: string; snippet: string }>;

  // secrets (values never leave the harness except into allowed requests)
  setSecret(userKey: string, name: string, value: string, hosts: string[], now: Date): void;
  getSecret(userKey: string, name: string): { value: string; hosts: string[] } | null;
  listSecrets(userKey: string): Array<{ name: string; hosts: string[]; updatedAt: string }>;
  allowSecretHost(userKey: string, name: string, host: string): void;
  removeSecret(userKey: string, name: string): boolean;

  /** Deletes a user's data. 'chat': transcript and summary. 'memory': plus facts, skills, profile. 'all': plus journal, notes, reminders, secrets. */
  wipeUser(userKey: string, scope: 'chat' | 'memory' | 'all'): void;

  recordTurn(t: Omit<TurnRecord, 'id' | 'feedback' | 'feedbackScore'>): number;
  attachTurnMessages(turnId: number, messageIds: number[]): void;
  turnForMessage(userKey: string, messageId: number): { id: number; at: string } | null;
  setTurnFeedback(turnId: number, emoji: string, score: number, at: Date): void;
  addIssue(userKey: string, kind: string, text: string, at: Date, turnId?: number): number;
  turnsSince(sinceIso: string, userKey?: string): TurnRecord[];
  /** The conversation since a time, oldest first (bounded). */
  messagesSince(userKey: string, sinceIso: string, limit?: number): StoredMessage[];
  issuesSince(sinceIso: string, userKey?: string): IssueRecord[];
  /** Drops turn and issue logs older than this. */
  pruneLogs(beforeIso: string): number;
}

// ---------------------------------------------------------------------------
// Ports (the outside world, injected)
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean;
  remotePageId?: string;
  remoteUrl?: string;
  /** Human-readable reason when ok is false. */
  error?: string;
  /** True when retrying cannot help until the person acts (sign in again, other account). */
  permanent?: boolean;
}

/** The remote notes library (OneNote), per person. Optional. Everything is local-first. */
export interface LibraryPort {
  /** Last known status, from cache; never blocks a turn. */
  isConnected(userKey: string): boolean;
  /** Probes the connection (and refreshes the cache). */
  status(userKey: string): Promise<{ connected: boolean; label?: string; error?: string }>;
  search(userKey: string, query: string, limit: number): Promise<NoteHit[]>;
  /** `ref` is a NoteHit.ref of the form 'remote:<id>'. */
  read(userKey: string, ref: string): Promise<{ path: string; text: string; url?: string } | null>;
  syncDay(userKey: string, day: JournalDay, markdown: string): Promise<SyncResult>;
  syncNote(userKey: string, note: Note): Promise<SyncResult>;
  /** Where journal days are copied. */
  journalTarget?(userKey: string): { notebook: string; section: string };
  /** Moves future journal copies to this notebook/section (created when missing). */
  setJournalTarget?(userKey: string, notebook: string, section: string): Promise<{ notebook: string; section: string }>;
}

/** How a person connects an outside service: a link to open, or a code to type at a link. */
export type ConnectOffer = { url: string; note?: string } | { url: string; code: string; expiresInMin: number } | { error: string };

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebPort {
  /** region: ISO 3166 two-letter country code for local news. */
  search(query: string, limit: number, opts?: { kind?: 'web' | 'news'; region?: string }): Promise<WebResult[]>;
  fetch(url: string): Promise<{ url: string; title: string; text: string }>;
}

export interface DataPort {
  rate(from: string, to: string[]): Promise<{ base: string; rates: Record<string, number>; updated: string; source: string }>;
  weather(place: string): Promise<{
    place: string;
    country?: string;
    timezone: string;
    current: { tempC: number; feelsC?: number; windKph: number; humidity?: number; description: string };
    days: Array<{ date: string; minC: number; maxC: number; rainMm: number; rainChance?: number; description: string }>;
    source: string;
  }>;
  verse(reference: string, translation?: string): Promise<{ reference: string; text: string; translation: string; source: string }>;
  wiki(topic: string): Promise<{ title: string; summary: string; url: string; source: string }>;
}

/** Speech-to-text. Returns null when it could not transcribe (the caller says so honestly). */
export interface SensePort {
  transcribe(filePath: string, mime?: string): Promise<string | null>;
  name: string;
}

export interface Ports {
  library?: LibraryPort;
  web?: WebPort;
  sense?: SensePort;
  data?: DataPort;
  /** Returns a sign-in link for an outside service the person can connect (e.g. OneNote). */
  connectLink?: (userKey: string, service: string) => Promise<ConnectOffer>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type Effect =
  | { type: 'journal_opened'; date: string }
  | { type: 'journal_saved'; date: string; entryId: number; media: number }
  | { type: 'journal_closed'; date: string; wrapped: boolean }
  | { type: 'note_saved'; noteId: number; path: string }
  | { type: 'fact_saved'; factId: number }
  | { type: 'fact_removed'; factId: number }
  | { type: 'profile_updated' }
  | { type: 'skill_saved'; name: string }
  | { type: 'reminder_set'; reminderId: number }
  | { type: 'reminder_cancelled'; reminderId: number }
  | { type: 'undone'; what: UndoRecord['kind']; ref: string }
  | { type: 'searched'; where: 'journal' | 'notes' | 'web' | 'chat'; hits: number }
  | { type: 'approval_requested'; id: string; label: string }
  | { type: 'issue_reported'; kind: string; text: string };

export interface ToolContext {
  userKey: string;
  now: Date;
  timezone: string;
  inbound: Inbound;
  store: Store;
  ports: Ports;
  /** Mutable. The loop saves it once the turn ends. */
  state: UserState;
  profile: Profile;
  /** Tools push what really happened. The gateway and tests read these. */
  effects: Effect[];
  /** Note paths that searches returned this turn or recently. Used to check citations. */
  cited: Set<string>;
  /** True once forwarded or web content entered the turn. Writes then need the user's own words. */
  tainted: boolean;
  /** Set by stay_silent on scheduled/nudge turns. */
  silent: boolean;
  log?: Logger;
  /** True when the person approved this exact call with a button (skips the taint gate). */
  approved?: boolean;
}

export interface ToolResult {
  /** What the model observes. Always the truth, including refusals and failures. */
  content: string;
  ok: boolean;
}

export interface ToolDef {
  spec: ToolSpec;
  /** Changes state. Refused on scheduled/nudge turns and gated on tainted turns. */
  writes?: boolean;
  /** Only offered on scheduled/nudge turns. */
  backgroundOnly?: boolean;
  /** Describes a blocked call for an approval button. Writes without it are refused instead. */
  approvalLabel?: (args: Record<string, unknown>) => string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface CoreConfig {
  /** Max model rounds that may call tools in one turn. */
  maxToolRounds: number;
  /** Max tokens per model call (must leave room for reasoning tokens). */
  maxTokens: number;
  temperature: number;
  /** Verbatim history budget, in characters. */
  historyChars: number;
  /** Summarize once un-summarized history exceeds this many characters. */
  compactAtChars: number;
  /** Whole-turn deadline. */
  turnTimeoutMs: number;
  /** How many of the most recent user photos are re-attached as images. */
  recentImages: number;
  /** Tool rounds for scheduled/background turns (research tasks need more). */
  maxToolRoundsBackground: number;
  /** Prompt+completion tokens per user per local day. 0 disables the cap. */
  dailyTokenCap: number;
  /** Timezone for people who haven't told you theirs (deployment setting, e.g. from TIMEZONE). */
  defaultTimezone: string;
}

export const DEFAULT_CONFIG: CoreConfig = {
  maxToolRounds: 8,
  maxTokens: 4096,
  temperature: 0.6,
  historyChars: 24_000,
  compactAtChars: 36_000,
  turnTimeoutMs: 150_000,
  recentImages: 2,
  maxToolRoundsBackground: 16,
  dailyTokenCap: 3_000_000,
  defaultTimezone: 'UTC',
};

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Deps {
  store: Store;
  model: ModelClient;
  ports: Ports;
  config?: Partial<CoreConfig>;
  log?: Logger;
}

export interface TurnRequest {
  userKey: string;
  inbound: Inbound;
  now?: Date;
  /** Overrides the profile timezone when the profile has none. */
  timezone?: string;
  /** Aborts the turn (e.g. /stop). */
  signal?: AbortSignal;
}

export interface ToolEvent {
  name: string;
  phase: 'start' | 'end';
  ok?: boolean;
}

export interface TurnHooks {
  /** Visible reply text so far, for streaming. May restart from '' when a round ends in tool calls. */
  onText?: (full: string) => void;
  onTool?: (ev: ToolEvent) => void;
}

export interface TraceStep {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: string;
  ms: number;
}

export interface TurnResult {
  /** What to say. Empty only when `silent` is true. */
  reply: string;
  /** True when a nudge/scheduled turn decided there is nothing worth saying. */
  silent: boolean;
  effects: Effect[];
  trace: TraceStep[];
  usage: Usage;
  rounds: number;
  /** Set when the model could not be reached and the harness answered on its own. */
  degraded?: 'model_unavailable' | 'not_configured' | 'timeout' | 'stopped' | 'daily_cap';
  /** Approvals requested this turn; the gateway shows a button for each. */
  approvals: PendingApproval[];
  /** Corrections the loop asked the model to make (truthfulness / citation / empty reply). */
  corrections: string[];
  state: UserState;
  /** provider:model that wrote the reply. */
  model?: string;
  /** Wall time of the turn, set by the core. */
  ms?: number;
  /** Row in the turn log, set by the core. */
  turnId?: number;
}
