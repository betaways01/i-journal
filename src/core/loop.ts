/**
 * The turn loop: see -> think -> tools -> observe -> speak.
 * The model decides what to do and what to say. The loop never rewrites the reply; when a reply
 * claims something no tool did, or cites a note no search returned, it asks the model once to fix it.
 */
import { buildMessages, storedUserText } from './context';
import { localParts, isValidTimezone } from './time';
import { executeTool, toolSpecsFor } from './tools';
import { sessionDate } from './tools/journal';
import {
  ChatMessage,
  CoreConfig,
  DEFAULT_CONFIG,
  Deps,
  Effect,
  ModelUnavailableError,
  NewMessage,
  ToolContext,
  TraceStep,
  TurnHooks,
  TurnRequest,
  TurnResult,
  Usage,
} from './types';

const HARNESS = '[harness note — not from them] ';

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
}

function addUsage(a: Usage, b: Usage): void {
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.cachedTokens += b.cachedTokens;
  a.reasoningTokens += b.reasoningTokens;
}

function recordUsage(state: TurnResult['state'], day: string, usage: Usage, turns: number): void {
  const all = { ...(state.usage || {}) };
  const cur = all[day] || { prompt: 0, completion: 0, turns: 0 };
  all[day] = { prompt: cur.prompt + usage.promptTokens, completion: cur.completion + usage.completionTokens, turns: cur.turns + turns };
  state.usage = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)).slice(-14));
}

export function configOf(deps: Deps): CoreConfig {
  return { ...DEFAULT_CONFIG, ...(deps.config || {}) };
}

export function describeEffects(effects: Effect[]): string {
  const out: string[] = [];
  for (const e of effects) {
    switch (e.type) {
      case 'journal_opened':
        out.push(`opened the journal for ${e.date}`);
        break;
      case 'journal_saved':
        out.push(`saved an entry to ${e.date}`);
        break;
      case 'journal_closed':
        out.push(`closed the journal for ${e.date}${e.wrapped ? ' with a reflection' : ''}`);
        break;
      case 'note_saved':
        out.push(`saved the note ${e.path}`);
        break;
      case 'fact_saved':
        out.push(`kept fact #${e.factId}`);
        break;
      case 'fact_removed':
        out.push(`forgot fact #${e.factId}`);
        break;
      case 'profile_updated':
        out.push('updated their profile');
        break;
      case 'skill_saved':
        out.push(`saved the procedure "${e.name}"`);
        break;
      case 'reminder_set':
        out.push(`set reminder #${e.reminderId}`);
        break;
      case 'reminder_cancelled':
        out.push(`cancelled reminder #${e.reminderId}`);
        break;
      case 'undone':
        out.push('undid the last change');
        break;
      default:
        break;
    }
  }
  return out.join('; ');
}

// ---------------------------------------------------------------------------
// Checks on the model's own reply (never on the person's words)
// ---------------------------------------------------------------------------

interface ClaimRule {
  what: string;
  test: (s: string) => boolean;
  backedBy: Effect['type'][];
  /** Only checked when this holds (e.g. the journal was open when the turn began). */
  when?: (c: ClaimContext) => boolean;
}

const NEGATION = /\b(not|never|didn'?t|haven'?t|hasn'?t|won'?t|can'?t|couldn'?t|wasn'?t|isn'?t|unable)\b|n't\b/i;

const CLAIM_RULES: ClaimRule[] = [
  {
    what: 'saved something to the journal',
    test: (s) =>
      /\b(saved|added|put|wrote|written|logged|noted|recorded|jotted|captured|filed)\b/i.test(s) && /\b(journal|today'?s page|the page|your page|diary|entry)\b/i.test(s),
    backedBy: ['journal_saved', 'journal_closed'],
  },
  {
    what: 'closed the journal',
    test: (s) => /\b(closed|closing|wrapped|wrapping|done with)\b[^.!?\n]{0,25}\b(it|the journal|the page|today|for today|for the day)\b/i.test(s) || /^\s*(closed|wrapped)\b/i.test(s),
    backedBy: ['journal_closed'],
    when: (c) => c.journalOpen,
  },
  {
    what: 'set a reminder',
    test: (s) => /\b(i'?ll|i will|i'?m going to)\s+(remind|ping|nudge)\s+you\b/i.test(s) || /\breminder\b[^.!\n]{0,30}\b(is\s+)?(set|scheduled|created|on)\b/i.test(s) || /\b(set|scheduled)\s+(a|the|your|that)\s+reminder\b/i.test(s),
    backedBy: ['reminder_set'],
  },
  {
    what: 'cancelled a reminder',
    test: (s) => /\b(cancell?ed|removed|deleted)\b[^.!\n]{0,30}\breminder\b/i.test(s),
    backedBy: ['reminder_cancelled', 'undone'],
  },
  {
    what: 'remembered something',
    test: (s) =>
      /\b(i'?ll remember|i will remember|i'?ve remembered|i'?ll keep (that|this|it) in mind|i'?ve (noted|made a note)|noted that|added (that|this|it) to (my )?memory|i'?ll make a note|from now on|from here( on)?|going forward|i'?ll keep (it|things|replies|answers) (short|shorter|brief|casual)|(short|brief) and casual|(shorter|briefer|more casual) (from|going))\b/i.test(s),
    backedBy: ['fact_saved', 'profile_updated', 'skill_saved'],
  },
  {
    what: 'saved a note to their notes',
    test: (s) => /\b(saved|added|put|filed)\b[^.!\n]{0,40}\b(notes|notebook|library)\b/i.test(s),
    backedBy: ['note_saved'],
  },
  {
    // Allowed when the context or a tool result this turn showed a confirmed copy.
    what: 'put something in OneNote',
    test: (s) => /\bonenote\b/i.test(s) && /\b(saved|synced|added|copied|uploaded|stored|is in|it'?s in|now in)\b/i.test(s) && !/\b(will be|going to be|gets?|once)\b/i.test(s),
    backedBy: [],
    when: (c) => !c.oneNoteConfirmed,
  },
];

export interface ClaimContext {
  journalOpen: boolean;
  /** A confirmed OneNote copy is visible to the model this turn. */
  oneNoteConfirmed?: boolean;
}

export function unbackedClaim(reply: string, effects: Effect[], ctx: ClaimContext = { journalOpen: false }): string | null {
  const done = new Set(effects.map((e) => e.type));
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() && !s.includes('?') && !NEGATION.test(s));
  for (const rule of CLAIM_RULES) {
    if (rule.when && !rule.when(ctx)) continue;
    if (!sentences.some(rule.test)) continue;
    if (rule.backedBy.some((t) => done.has(t))) continue;
    return rule.what;
  }
  return null;
}

const SEG_DELIM = /[,.;:!?()"“”‘’*_`[\]<>—–]/;

function normSeg(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Note-path-looking spans in the reply: "Notebook / Section / Title" or "Notebook / Title". */
export function pathCandidates(reply: string): string[][] {
  const out: string[][] = [];
  for (const line of reply.split('\n')) {
    if (!line.includes(' / ')) continue;
    const segs = line.split(' / ');
    const head = segs[0].split(SEG_DELIM).pop() || '';
    const tailSeg = segs[segs.length - 1];
    const tail = tailSeg.split(SEG_DELIM)[0] || '';
    const parts = [head, ...segs.slice(1, -1), tail].map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3) continue;
    if (parts.some((p) => !p || p.length > 80 || !/\p{L}/u.test(p) || SEG_DELIM.test(p))) continue;
    // "every Mon / Wed / Fri at 7": judge by the words touching the slashes.
    const touching = [parts[0].split(' ').pop() || '', ...parts.slice(1, -1), parts[parts.length - 1].split(' ')[0] || ''];
    if (touching.every((p) => p.length <= 3)) continue;
    out.push(parts);
  }
  return out;
}

/** The span around a path may carry extra words: "Your note Personal / MONEY / Business says". */
function segMatches(cand: string, known: string, pos: 'head' | 'mid' | 'tail'): boolean {
  const c = normSeg(cand);
  const k = normSeg(known);
  if (!k) return false;
  if (c === k) return true;
  // A dash or bracket in a real title cuts the span short, so a truncated end still counts.
  if (pos === 'head') return c.endsWith(' ' + k) || (c.length >= 3 && k.endsWith(c));
  if (pos === 'tail') return c.startsWith(k + ' ') || (c.length >= 3 && k.startsWith(c));
  return false;
}

function matchesPath(parts: string[], known: string[]): boolean {
  let i = 0;
  for (const k of known) {
    if (i >= parts.length) break;
    const pos = i === 0 ? 'head' : i === parts.length - 1 ? 'tail' : 'mid';
    if (segMatches(parts[i], k, pos)) i++;
  }
  return i === parts.length;
}

export function uncitedPaths(reply: string, cited: Set<string>, notebooks: string[]): string[] {
  const known = [...cited].map((p) => p.split(' / '));
  const books = [...new Set([...notebooks, ...known.map((k) => k[0])])];
  const bad: string[] = [];
  for (const parts of pathCandidates(reply)) {
    if (parts.length === 2 && !books.some((b) => segMatches(parts[0], b, 'head'))) continue;
    if (known.some((k) => matchesPath(parts, k))) continue;
    bad.push(parts.join(' / '));
  }
  return bad;
}

const URL_RE = /https?:\/\/[^\s<>()"'\]\[`*]+/gi;

/** Links in the reply that appear nowhere in what the model was given (tool results, their words, history). */
export function inventedLinks(reply: string, context: string): string[] {
  const out: string[] = [];
  for (const raw of reply.match(URL_RE) || []) {
    const url = raw.replace(/[.,;:!?)]+$/, '');
    if (!context.includes(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

function contextText(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')))
    .join('\n');
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export async function runTurn(deps: Deps, req: TurnRequest, hooks: TurnHooks = {}): Promise<TurnResult> {
  const cfg = configOf(deps);
  const { store, model, ports } = deps;
  const log = deps.log;
  const now = req.now ?? new Date();
  const at = now.toISOString();
  const { userKey, inbound } = req;
  const background = inbound.kind === 'scheduled' || inbound.kind === 'nudge';

  const profile = store.getProfile(userKey);
  const fallbackTz = isValidTimezone(cfg.defaultTimezone) ? cfg.defaultTimezone : 'UTC';
  const tzWanted = profile.timezone || req.timezone || fallbackTz;
  const timezone = isValidTimezone(tzWanted) ? tzWanted : fallbackTz;
  const state = store.getState(userKey);
  const firstMeeting = !background && state.turnCount === 0 && !profile.name && store.listFacts(userKey).length === 0;
  const journalOpenAtStart = state.journalOpen;
  if (!background) {
    state.turnCount += 1;
    state.firstSeenAt = state.firstSeenAt || at;
    state.lastSeenAt = at;
  }

  const ctx: ToolContext = {
    userKey,
    now,
    timezone,
    inbound,
    store,
    ports,
    state,
    profile,
    effects: [],
    cited: new Set(state.cited || []),
    tainted: Boolean(inbound.forwarded),
    silent: false,
    log,
  };

  const messages: ChatMessage[] = buildMessages({
    store,
    userKey,
    state,
    profile,
    timezone,
    now,
    inbound,
    config: cfg,
    canSee: model.supportsImages(),
    libraryConnected: Boolean(ports.library?.isConnected(userKey)),
    journalTarget: ports.library?.journalTarget?.(userKey),
    firstMeeting,
    canConnect: Boolean(ports.connectLink),
    canHear: Boolean(ports.sense),
  });

  const userRow: NewMessage = {
    role: 'user',
    content: storedUserText(inbound),
    at,
    media: inbound.media.length ? inbound.media : undefined,
    origin: inbound.kind,
  };
  if (!background) store.appendMessages(userKey, [userRow]);

  const pending: NewMessage[] = [];
  const trace: TraceStep[] = [];
  const corrections: string[] = [];
  const usage = emptyUsage();
  const specs = toolSpecsFor(background);
  const notebooks = store.listNotebooks(userKey).map((n) => n.notebook);
  let rounds = 0;
  let reply = '';
  let degraded: TurnResult['degraded'];
  let modelUsed: string | undefined;

  const ac = new AbortController();
  let timedOut = false;
  let stopped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, cfg.turnTimeoutMs);
  const onStop = () => {
    stopped = true;
    ac.abort();
  };
  if (req.signal?.aborted) onStop();
  else req.signal?.addEventListener('abort', onStop, { once: true });

  const today = localParts(now, timezone).date;
  const spent = state.usage?.[today];
  const overCap = cfg.dailyTokenCap > 0 && spent !== undefined && spent.prompt + spent.completion >= cfg.dailyTokenCap;
  const maxRounds = background ? cfg.maxToolRoundsBackground : cfg.maxToolRounds;

  try {
    if (overCap) throw Object.assign(new Error('daily token cap reached'), { name: 'DailyCap' });
    let textOnly = false;
    const maxCalls = maxRounds + 4;
    for (let call = 0; call < maxCalls; call++) {
      const toolsAllowed = !textOnly && rounds < maxRounds;
      const res = await model.complete({
        messages,
        tools: specs,
        toolChoice: toolsAllowed ? 'auto' : 'none',
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        signal: ac.signal,
        onText: hooks.onText,
        purpose: 'turn',
      });
      addUsage(usage, res.usage);
      if (res.provider || res.model) modelUsed = [res.provider, res.model].filter(Boolean).join(':');

      if (res.toolCalls.length && toolsAllowed) {
        rounds++;
        hooks.onText?.('');
        messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });
        pending.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, at });
        for (const c of res.toolCalls) {
          hooks.onTool?.({ name: c.name, phase: 'start' });
          const t0 = Date.now();
          const r = await executeTool(c, ctx);
          trace.push({ round: rounds, tool: c.name, args: r.args, ok: r.ok, result: r.content, ms: Date.now() - t0 });
          hooks.onTool?.({ name: c.name, phase: 'end', ok: r.ok });
          messages.push({ role: 'tool', content: r.content, tool_call_id: c.id });
          pending.push({ role: 'tool', content: r.content, toolCallId: c.id, toolName: c.name, at });
        }
        if (!background) store.saveState(userKey, { ...state, cited: [...ctx.cited].slice(-50) });
        if (ctx.silent) break;
        continue;
      }
      if (rounds >= maxRounds && !textOnly && !corrections.includes('round_budget')) corrections.push('round_budget');

      const text = res.text.trim();
      if (!text) {
        if (!corrections.includes('empty')) {
          corrections.push('empty');
          hooks.onText?.('');
          messages.push({ role: 'user', content: HARNESS + 'Your last reply was empty. Reply to them now, in plain words.' });
          textOnly = true;
          continue;
        }
        break;
      }
      if (!corrections.includes('claim')) {
        const claim = unbackedClaim(text, ctx.effects, { journalOpen: journalOpenAtStart, oneNoteConfirmed: /OneNote copy: up to date/.test(contextText(messages)) });
        if (claim) {
          corrections.push('claim');
          hooks.onText?.('');
          const done = describeEffects(ctx.effects) || 'nothing was changed';
          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content:
              HARNESS +
              `Your reply says you ${claim}, but no tool did that in this turn (what actually happened: ${done}). If they asked for it, call the tool now and then reply. Otherwise rewrite your reply so it doesn't claim it. If you were only referring to something done in an earlier turn, send the same reply again.`,
          });
          continue;
        }
      }
      if (!corrections.includes('link')) {
        const links = inventedLinks(text, contextText(messages));
        if (links.length) {
          corrections.push('link');
          hooks.onText?.('');
          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content:
              HARNESS +
              `Your reply contains a link no tool gave you and they didn't send: ${links.join(', ')}. Never make up links. Call the tool that provides it (connect_service for OneNote; web_search to find a real page) or rewrite without it.`,
          });
          continue;
        }
      }
      if (!corrections.includes('citation')) {
        const bad = uncitedPaths(text, ctx.cited, notebooks);
        if (bad.length) {
          corrections.push('citation');
          hooks.onText?.('');
          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content:
              HARNESS +
              `Your reply cites ${bad.map((b) => `"${b}"`).join(', ')}, but no search returned that note. Search for it with notes_search, or rewrite without the citation. If that text is not a note citation at all, send the same reply again.`,
          });
          continue;
        }
      }
      reply = text;
      break;
    }
  } catch (err) {
    degraded =
      err instanceof Error && err.name === 'DailyCap'
        ? 'daily_cap'
        : stopped
          ? 'stopped'
          : timedOut
            ? 'timeout'
            : err instanceof ModelUnavailableError && /no model provider configured/.test(err.message)
              ? 'not_configured'
              : 'model_unavailable';
    if (degraded === 'not_configured') {
      log?.error('turn: no model provider is configured (set DEEPSEEK_API_KEY, or the owner sends /key DEEPSEEK_API_KEY …)');
    } else if (degraded === 'model_unavailable' && !(err instanceof ModelUnavailableError) && !isAbort(err)) {
      log?.error('turn: model call failed unexpectedly', { error: err instanceof Error ? err.message : String(err) });
    } else {
      log?.warn('turn degraded', { reason: degraded, error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onStop);
  }

  let silent = false;
  if (background && (ctx.silent || degraded || !reply)) {
    silent = true;
    reply = '';
  } else if (degraded) {
    reply = degradedReply(ctx, degraded);
  } else if (!reply) {
    degraded = 'model_unavailable';
    reply = degradedReply(ctx, degraded);
  }

  if (!silent) {
    const rows: NewMessage[] = background ? [userRow, ...pending] : [...pending];
    rows.push({ role: 'assistant', content: reply, at, origin: inbound.kind });
    store.appendMessages(userKey, rows);
  }
  state.cited = [...ctx.cited].slice(-50);
  if (!background) state.feedback = undefined;
  recordUsage(state, today, usage, 1);
  store.saveState(userKey, state);

  const requested = new Set(ctx.effects.flatMap((e) => (e.type === 'approval_requested' ? [e.id] : [])));
  const approvals = (state.approvals || []).filter((a) => requested.has(a.id));
  return { reply, silent, effects: ctx.effects, trace, usage, rounds, degraded, corrections, state, approvals, model: modelUsed };
}

function degradedReply(ctx: ToolContext, why: NonNullable<TurnResult['degraded']>): string {
  const lead =
    why === 'stopped'
      ? 'Stopped.'
      : why === 'daily_cap'
        ? "I've hit today's usage limit, so I'm pausing until tomorrow."
        : why === 'timeout'
          ? 'That took me too long, so I stopped before finishing my answer.'
          : why === 'not_configured'
            ? "I'm not fully switched on yet: the server has no AI model key, so I can't think up answers."
            : "I couldn't reach my thinking model just now, so I can't answer properly yet.";
  const done = describeEffects(ctx.effects);
  const parts = [lead];
  if (done) parts.push(`Before that I ${done}.`);
  const inbound = ctx.inbound;
  const alreadySaved = ctx.effects.some((e) => e.type === 'journal_saved');
  if (why !== 'stopped' && ctx.state.journalOpen && !alreadySaved && inbound.kind === 'message' && !inbound.forwarded && (inbound.text || inbound.transcript || inbound.media.some((m) => m.kind !== 'sticker'))) {
    const date = sessionDate(ctx);
    const text = [inbound.text, inbound.transcript].filter(Boolean).join('\n');
    const media = inbound.media.filter((m) => m.kind !== 'sticker');
    const { day, entry } = ctx.store.addEntry(ctx.userKey, date, { text, media, at: ctx.now, localTime: localParts(ctx.now, ctx.timezone).time });
    ctx.effects.push({ type: 'journal_saved', date, entryId: entry.id, media: media.length });
    ctx.state.undo = [{ kind: 'journal_entry' as const, ref: String(entry.id), date, at: ctx.now.toISOString(), label: (text || 'media').slice(0, 60) }, ...ctx.state.undo].slice(0, 20);
    parts.push(`The journal is open, so I put your message on the page as you wrote it (${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'} now).`);
  } else if (why !== 'stopped') {
    parts.push(why === 'daily_cap' ? 'Your message is saved.' : "Nothing is lost — I have your message. Send it again in a minute and I'll pick it up.");
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

function transcriptLine(m: { role: string; content: string; toolCalls?: Array<{ name: string; arguments: string }>; toolName?: string }): string {
  if (m.role === 'user') return 'Them: ' + m.content;
  if (m.role === 'tool') return `  (${m.toolName || 'tool'} result: ${m.content.replace(/\s+/g, ' ').slice(0, 200)})`;
  const calls = (m.toolCalls || []).map((c) => `${c.name}(${c.arguments.slice(0, 120)})`).join(', ');
  return 'You: ' + [m.content, calls ? `[called ${calls}]` : ''].filter(Boolean).join(' ');
}

/**
 * Folds older conversation into a rolling summary once it outgrows the budget. Call after a turn has
 * been delivered, inside the same per-user queue. Returns true when a summary was written.
 */
export async function compactIfNeeded(deps: Deps, userKey: string): Promise<boolean> {
  const cfg = configOf(deps);
  const state = deps.store.getState(userKey);
  const msgs = deps.store.messagesAfter(userKey, state.summaryThrough);
  const total = msgs.reduce((n, m) => n + m.content.length + (m.toolCalls || []).reduce((k, c) => k + c.arguments.length, 0), 0);
  if (total <= cfg.compactAtChars) return false;

  const keepChars = Math.floor(cfg.historyChars / 2);
  let kept = 0;
  let cut = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    kept += msgs[i].content.length;
    if (kept > keepChars) break;
    cut = i;
  }
  while (cut < msgs.length && msgs[cut].role !== 'user') cut++;
  const older = msgs.slice(0, cut);
  if (!older.length) return false;

  const body = older.map(transcriptLine).join('\n').slice(-60_000);
  try {
    const res = await deps.model.complete({
      messages: [
        {
          role: 'system',
          content:
            'You keep a running summary of a long conversation between a person and their companion. Write in the third person about "them". Keep: facts about their life and people, commitments and plans, how they were feeling, open threads, what the companion did (saved, reminded, promised). Drop small talk. Be concrete. At most 350 words.',
        },
        { role: 'user', content: `Summary so far:\n${state.summary || '(none)'}\n\nConversation to fold in:\n${body}\n\nWrite the updated summary.` },
      ],
      toolChoice: 'none',
      maxTokens: 2048,
      temperature: 0.2,
      purpose: 'summary',
    });
    const text = res.text.trim();
    if (!text) return false;
    const fresh = deps.store.getState(userKey);
    fresh.summary = text.slice(0, 6000);
    fresh.summaryThrough = older[older.length - 1].id;
    deps.store.saveState(userKey, fresh);
    return true;
  } catch (err) {
    deps.log?.warn('compaction failed; will retry next turn', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
