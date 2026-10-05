/**
 * What the turn log says about how the app is doing: speed, failures, corrections, feedback, and the
 * issues the companion reported. Used by /debug, /export and `npm run insights`.
 */
import crypto from 'crypto';
import { IssueRecord, Store, TurnRecord } from './types';

/** Nearest-rank percentile of an ascending list. */
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function count<T>(items: T[], key: (t: T) => string | undefined): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Positive / negative / neutral reading of a reaction emoji. */
export function reactionScore(emoji: string): number {
  if (['👍', '❤', '❤️', '🔥', '🥰', '👏', '😁', '🎉', '🤩', '🙏', '👌', '😍', '💯', '🤗', '❤‍🔥', '⚡', '🏆', '😇', '🫡', '🕊', '😘', '🆒', '✍'].includes(emoji)) return 1;
  if (['👎', '💩', '🤮', '🤬', '😡', '🤡', '🥱', '🙄', '🤨', '🖕', '😴'].includes(emoji)) return -1;
  return 0;
}

export interface InsightOptions {
  since: Date;
  /** Label for whose turns these are, for the heading. */
  scope?: string;
  /** Issue texts are shown only for this person; others' are counted, never quoted. */
  viewer?: string;
}

export function summarize(turns: TurnRecord[], issues: IssueRecord[], opts: InsightOptions): string {
  const lines: string[] = [`🔧 *How it's going* — since ${opts.since.toISOString().slice(0, 16).replace('T', ' ')} UTC${opts.scope ? ` (${opts.scope})` : ''}`];
  if (!turns.length && !issues.length) return lines.concat('', 'No turns logged in this window.').join('\n');

  const people = new Set(turns.map((t) => t.userKey)).size;
  const byKind = count(turns, (t) => t.kind).map(([k, n]) => `${n} ${k}`).join(', ');
  lines.push('', `*Turns:* ${turns.length} (${byKind}) from ${people} ${people === 1 ? 'person' : 'people'}`);

  const ms = turns.filter((t) => !t.silent).map((t) => t.ms).sort((a, b) => a - b);
  if (ms.length) {
    const slowest = turns.reduce((a, b) => (b.ms > a.ms ? b : a));
    lines.push(`*Speed:* median ${secs(pct(ms, 0.5))}, 95% under ${secs(pct(ms, 0.95))}, slowest ${secs(slowest.ms)} (turn #${slowest.id}${slowest.tools.length ? `, ${slowest.tools.map((x) => x.tool).join(' → ')}` : ''})`);
  }

  const prompt = turns.reduce((s, t) => s + t.promptTokens, 0);
  const completion = turns.reduce((s, t) => s + t.completionTokens, 0);
  const cached = turns.reduce((s, t) => s + t.cachedTokens, 0);
  const models = count(turns, (t) => t.model).map(([m, n]) => `${m} ×${n}`).join(', ');
  lines.push(`*Tokens:* ${(prompt + completion).toLocaleString('en-US')} (${prompt ? Math.round((cached / prompt) * 100) : 0}% of input cached)${models ? ` — ${models}` : ''}`);

  const degraded = count(turns, (t) => t.degraded);
  const crashed = turns.filter((t) => t.error);
  if (degraded.length || crashed.length) {
    lines.push(`*Problems:* ${[...degraded.map(([k, n]) => `${k} ×${n}`), ...(crashed.length ? [`crashed ×${crashed.length}`] : [])].join(', ')}`);
    const last = crashed.at(-1);
    if (last) lines.push(`  last crash (#${last.id}): ${(last.error || '').split('\n')[0].slice(0, 200)}`);
  }

  const calls = turns.flatMap((t) => t.tools);
  if (calls.length) {
    const failed = calls.filter((c) => !c.ok);
    const used = count(calls, (c) => c.tool).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`*Tools:* ${calls.length} calls — ${used}`);
    if (failed.length) {
      const why = count(failed, (c) => c.tool).map(([k, n]) => `${k} ×${n}`).join(', ');
      lines.push(`*Tool failures:* ${failed.length} — ${why}`);
      const recent = failed.slice(-3).map((c) => `  • ${c.tool}: ${(c.error || '').slice(0, 140)}`);
      lines.push(...recent);
    }
  }

  const corrections = count(turns.flatMap((t) => t.corrections), (c) => c);
  if (corrections.length) lines.push(`*Self-corrections:* ${corrections.map(([k, n]) => `${k} ×${n}`).join(', ')}`);

  const rated = turns.filter((t) => t.feedback);
  if (rated.length) {
    const up = rated.filter((t) => (t.feedbackScore ?? 0) > 0).length;
    const down = rated.filter((t) => (t.feedbackScore ?? 0) < 0);
    lines.push(`*Reactions:* 👍 ${up}, 👎 ${down.length}, other ${rated.length - up - down.length}`);
    for (const t of down.slice(-3)) lines.push(`  • 👎 turn #${t.id} (${t.at.slice(5, 16).replace('T', ' ')}): ${t.tools.map((x) => x.tool).join(', ') || 'no tools'}${t.corrections.length ? `, corrected: ${t.corrections.join(',')}` : ''}`);
  }

  if (issues.length) {
    const own = opts.viewer === undefined ? issues : issues.filter((i) => i.userKey === opts.viewer);
    const others = issues.length - own.length;
    lines.push('', `*Reported by the companion* (${issues.length}):`);
    for (const i of own.slice(-8)) lines.push(`  • [${i.kind}] ${i.text.slice(0, 220)}`);
    if (others) lines.push(`  • ${others} from other people (${count(issues.filter((i) => !own.includes(i)), (i) => i.kind).map(([k, n]) => `${k} ×${n}`).join(', ')}) — their words stay private`);
  }
  return lines.join('\n');
}

const pseudonym = (userKey: string) => 'person-' + crypto.createHash('sha256').update(userKey).digest('hex').slice(0, 8);

/**
 * JSON lines for offline analysis: every turn and issue in the window, and the conversation of
 * `withTranscriptFor` (the person asking — never anyone else's words). Other people are pseudonymous.
 */
export function exportJsonl(store: Store, since: Date, withTranscriptFor: string): string {
  const sinceIso = since.toISOString();
  const who = (k: string) => (k === withTranscriptFor ? k : pseudonym(k));
  const out: string[] = [];
  out.push(JSON.stringify({ type: 'export', since: sinceIso, at: new Date().toISOString() }));
  for (const t of store.turnsSince(sinceIso)) out.push(JSON.stringify({ type: 'turn', ...t, userKey: who(t.userKey) }));
  for (const i of store.issuesSince(sinceIso)) {
    out.push(JSON.stringify({ type: 'issue', ...i, userKey: who(i.userKey), text: i.userKey === withTranscriptFor ? i.text : '(private)' }));
  }
  for (const m of store.messagesSince(withTranscriptFor, sinceIso)) {
    out.push(JSON.stringify({ type: 'message', at: m.at, role: m.role, origin: m.origin, content: m.content, tool: m.toolName }));
  }
  return out.join('\n') + '\n';
}
