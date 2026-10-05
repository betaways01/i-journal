import { Inbound, InboundMedia, JournalDay, StoredMessage, ToolContext, ToolResult, UndoRecord } from '../types';
import { formatLocal, localParts } from '../time';

export const ok = (content: string): ToolResult => ({ ok: true, content });
export const fail = (content: string): ToolResult => ({ ok: false, content });

export function argStr(args: Record<string, unknown>, key: string, max = 4000): string {
  const v = args[key];
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

export function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function argBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** What the person themselves wrote or said this turn. Forwarded content is someone else's words. */
export function ownWords(inbound: Inbound): string {
  if (inbound.forwarded) return '';
  return [inbound.text, inbound.transcript].filter(Boolean).join('\n');
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `quote` (the model's claim of what the person said) really appears in `source`. */
export function quoteAppears(quote: string, source: string): boolean {
  const q = norm(quote).replace(/^["'\s.,!?]+|["'\s.,!?]+$/g, '');
  if (q.length < 2) return false;
  return norm(source).includes(q);
}

export function pushUndo(ctx: ToolContext, rec: Omit<UndoRecord, 'at'>): void {
  ctx.state.undo = [{ ...rec, at: ctx.now.toISOString() }, ...(ctx.state.undo || [])].slice(0, 20);
}

export function mediaLabel(m: InboundMedia): string {
  switch (m.kind) {
    case 'photo':
      return 'photo';
    case 'voice':
      return 'voice note';
    case 'video_note':
      return 'video note';
    case 'sticker':
      return m.emoji ? `sticker ${m.emoji}` : 'sticker';
    case 'document':
      return m.fileName ? `document: ${m.fileName}` : 'document';
    default:
      return m.kind;
  }
}

export function renderDay(day: JournalDay): string {
  const lines = [`# ${day.weekday} ${day.date}`];
  if (!day.entries.length) lines.push('(nothing written)');
  for (const e of day.entries) {
    const media = e.media.length ? ' [' + e.media.map(mediaLabel).join(', ') + ']' : '';
    lines.push(`- ${e.localTime} — ${e.text || '(no text)'}${media}`);
  }
  if (day.reflection) lines.push('', '## Reflection', day.reflection);
  return lines.join('\n');
}

/** Most recent media the person sent, from this message, the replied-to message, or recent history. */
export function recentUserMedia(ctx: ToolContext): InboundMedia[] {
  const usable = (list: InboundMedia[] | undefined) => (list || []).filter((m) => m.kind !== 'sticker');
  if (usable(ctx.inbound.media).length) return usable(ctx.inbound.media);
  if (usable(ctx.inbound.target?.media).length) return usable(ctx.inbound.target?.media);
  const recent: StoredMessage[] = ctx.store.recentMessages(ctx.userKey, 12);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.role === 'user' && usable(m.media).length) return usable(m.media);
  }
  return [];
}

export function nowLine(ctx: ToolContext): string {
  return formatLocal(ctx.now, ctx.timezone);
}

export function todayOf(ctx: ToolContext): string {
  return localParts(ctx.now, ctx.timezone).date;
}

/** Truthful OneNote state of a stored day or note, for the model. */
export function copyStatus(item: { rev: number; syncedRev: number; syncedAt?: string; remoteUrl?: string }, timezone: string): string {
  if (item.syncedAt && item.rev <= item.syncedRev) {
    return `OneNote copy: up to date (copied ${formatLocal(new Date(item.syncedAt), timezone)}${item.remoteUrl ? `, ${item.remoteUrl}` : ''}).`;
  }
  return item.syncedAt ? 'OneNote copy: older version there; the latest changes are waiting to be copied (usually within minutes).' : 'OneNote copy: not copied yet (usually within minutes).';
}

export function remoteNote(ctx: ToolContext): string {
  return ctx.ports.library?.isConnected(ctx.userKey) ? 'It will be copied to OneNote in the background; that copy is not confirmed yet.' : 'OneNote is not connected, so it is stored here only.';
}
