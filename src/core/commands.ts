/**
 * Deterministic actions for slash commands with a required outcome (/journal, /thats_it, /new).
 * They act on the store directly and leave a short note in the transcript so the model knows.
 */
import { executeTool } from './tools';
import { isValidTimezone } from './time';
import { Deps, Effect, ToolContext, ToolResult } from './types';

export async function runDirectTool(
  deps: Deps,
  userKey: string,
  name: string,
  args: Record<string, unknown>,
  opts: { now?: Date; timezone?: string; command: string; approved?: boolean }
): Promise<ToolResult & { effects: Effect[] }> {
  const now = opts.now ?? new Date();
  const profile = deps.store.getProfile(userKey);
  const fallback = deps.config?.defaultTimezone && isValidTimezone(deps.config.defaultTimezone) ? deps.config.defaultTimezone : 'UTC';
  const tz = profile.timezone || opts.timezone || fallback;
  const state = deps.store.getState(userKey);
  const ctx: ToolContext = {
    userKey,
    now,
    timezone: isValidTimezone(tz) ? tz : fallback,
    inbound: { kind: opts.approved ? 'button' : 'message', text: opts.command, media: [] },
    store: deps.store,
    ports: deps.ports,
    state,
    profile,
    effects: [],
    cited: new Set(state.cited || []),
    tainted: false,
    silent: false,
    log: deps.log,
    approved: Boolean(opts.approved),
  };
  const res = await executeTool({ id: 'cmd_' + now.getTime(), name, arguments: JSON.stringify(args) }, ctx);
  deps.store.saveState(userKey, state);
  deps.store.appendMessages(userKey, [
    { role: 'user', content: opts.command, at: now.toISOString(), origin: 'command' },
    { role: 'assistant', content: `(${opts.command} → ${res.content.split('\n')[0]})`, at: now.toISOString(), origin: 'command' },
  ]);
  return { ok: res.ok, content: res.content, effects: ctx.effects };
}

/** Clears the conversation transcript and summary. Memory, journal and reminders stay. */
export function resetConversation(deps: Deps, userKey: string): void {
  deps.store.clearConversation(userKey);
  const st = deps.store.getState(userKey);
  st.summary = '';
  st.summaryThrough = 0;
  st.pendingOffer = undefined;
  st.cited = [];
  deps.store.saveState(userKey, st);
}

const APPROVAL_TTL_MS = 24 * 3600_000;

/**
 * Runs (or drops) a write the person was asked to approve with a button. Approved calls run exactly
 * as the model asked, skipping only the forwarded/web-content gate.
 */
export async function resolveApproval(
  deps: Deps,
  userKey: string,
  id: string,
  approve: boolean,
  opts: { now?: Date; timezone?: string } = {}
): Promise<{ found: boolean; ok?: boolean; content?: string; label?: string }> {
  const now = opts.now ?? new Date();
  const state = deps.store.getState(userKey);
  const a = (state.approvals || []).find((x) => x.id === id);
  if (!a) return { found: false };
  state.approvals = (state.approvals || []).filter((x) => x.id !== id);
  deps.store.saveState(userKey, state);
  if (now.getTime() - new Date(a.createdAt).getTime() > APPROVAL_TTL_MS) return { found: false };
  if (!approve) {
    deps.store.appendMessages(userKey, [{ role: 'user', content: `[declined] ${a.label}`, at: now.toISOString(), origin: 'button' }]);
    return { found: true, ok: true, content: 'Declined.', label: a.label };
  }
  const res = await runDirectTool(deps, userKey, a.tool, a.args, { now, timezone: opts.timezone, command: `[approved] ${a.label}`, approved: true });
  return { found: true, ok: res.ok, content: res.content, label: a.label };
}
