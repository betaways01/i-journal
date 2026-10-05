import { Fact, ToolDef } from '../types';
import { argStr, fail, ok } from './util';

export const undo: ToolDef = {
  writes: true,
  spec: {
    name: 'undo',
    description: 'Reverse the most recent change you made (a journal entry, note, kept fact, reminder, or closing the journal) when they ask to undo / take that back.',
    parameters: { type: 'object', properties: { user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' } } },
  },
  async run(_args, ctx) {
    const rec = ctx.state.undo[0];
    if (!rec) return ok('Nothing to undo.');
    ctx.state.undo = ctx.state.undo.slice(1);
    const s = ctx.store;
    let msg: string;
    switch (rec.kind) {
      case 'journal_entry': {
        const removed = s.removeEntry(ctx.userKey, rec.date || '', Number(rec.ref));
        msg = removed ? `Removed "${rec.label}" from ${rec.date}.` : `That entry from ${rec.date} was already gone.`;
        break;
      }
      case 'note': {
        const prev = rec.prev ? (JSON.parse(rec.prev) as { body: string }) : null;
        if (prev) msg = s.setNoteBody(ctx.userKey, Number(rec.ref), prev.body, ctx.now) ? `Restored the previous text of ${rec.label}.` : `${rec.label} no longer exists.`;
        else msg = s.removeNote(ctx.userKey, Number(rec.ref)) ? `Deleted the note ${rec.label}.` : `${rec.label} was already gone.`;
        break;
      }
      case 'fact': {
        if (rec.prev) {
          s.restoreFact(ctx.userKey, JSON.parse(rec.prev) as Fact);
          msg = `Brought back #${rec.ref}.`;
        } else msg = s.removeFact(ctx.userKey, Number(rec.ref)) ? `Forgot "${rec.label}" again.` : 'That fact was already gone.';
        break;
      }
      case 'reminder': {
        if (rec.prev === 'cancelled') msg = s.restoreReminder(ctx.userKey, Number(rec.ref)) ? `Reminder #${rec.ref} is back on.` : `Reminder #${rec.ref} could not be restored.`;
        else msg = s.cancelReminder(ctx.userKey, Number(rec.ref)) ? `Cancelled reminder #${rec.ref} ("${rec.label}").` : `Reminder #${rec.ref} had already fired or was cancelled.`;
        break;
      }
      case 'journal_close': {
        const prev = JSON.parse(rec.prev || '{}') as { reflection: string | null; closedAt: string | null; wasOpen: boolean; journalDate: string | null };
        s.setReflection(ctx.userKey, rec.ref, prev.reflection ?? undefined, prev.closedAt ? new Date(prev.closedAt) : undefined);
        if (prev.wasOpen) {
          ctx.state.journalOpen = true;
          ctx.state.journalDate = prev.journalDate ?? rec.ref;
        }
        msg = `Reopened ${rec.ref}${prev.wasOpen ? ' — the journal is open again' : ''}.`;
        break;
      }
      default:
        msg = 'Nothing to undo.';
    }
    ctx.effects.push({ type: 'undone', what: rec.kind, ref: rec.ref });
    return ok(msg);
  },
};

export const staySilent: ToolDef = {
  backgroundOnly: true,
  spec: {
    name: 'stay_silent',
    description: 'Send nothing this time. Use on a scheduled or background turn when there is nothing worth saying.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, ctx) {
    ctx.silent = true;
    return ok('Staying silent.');
  },
};

const ISSUE_KINDS = ['missing_capability', 'tool_failed', 'complaint', 'bug', 'idea'];

export const reportIssue: ToolDef = {
  spec: {
    name: 'report_issue',
    description:
      "Leave a one-line note for the app's developer; the person doesn't see it and you don't mention it. Use it when you couldn't do what they asked (no tool for it, a tool kept failing, a limit), when they complain about how you behaved, or when they wish the app could do something. Say what they wanted and what was missing. Never put secrets in it.",
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ISSUE_KINDS },
        text: { type: 'string', description: 'What they wanted, and what stopped you or what they disliked. One or two sentences.' },
      },
      required: ['kind', 'text'],
    },
  },
  async run(args, ctx) {
    const text = argStr(args, 'text', 600);
    if (!text) return fail('Error: text is empty.');
    const raw = argStr(args, 'kind', 40);
    const kind = ISSUE_KINDS.includes(raw) ? raw : 'idea';
    ctx.effects.push({ type: 'issue_reported', kind, text });
    return ok('Noted for the developer. Carry on with them as normal; no need to mention this.');
  },
};

export const miscTools = [undo, staySilent, reportIssue];
