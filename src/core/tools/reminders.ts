import { Recurrence, Reminder, ToolDef } from '../types';
import { formatDelta, formatLocal, parseLocalDateTime, validateRecurrence, zonedToUtc } from '../time';
import { argNum, argStr, fail, ok, pushUndo } from './util';

const MAX_MINUTES = 60 * 24 * 366 * 5;

export function describeRecurrence(r?: Recurrence): string {
  if (!r) return '';
  const unit = { minutely: 'minute', hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month' }[r.freq];
  const every = r.interval > 1 ? `every ${r.interval} ${unit}s` : `every ${unit}`;
  if (r.freq === 'weekly' && r.weekdays?.length) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${every} on ${r.weekdays.map((d) => names[d]).join(', ')}`;
  }
  return every;
}

export function describeReminder(r: Reminder, tz: string, now: Date): string {
  const when = new Date(r.fireAt);
  const rec = r.recurrence ? `, repeats ${describeRecurrence(r.recurrence)}` : '';
  const kind = r.kind === 'task' ? ' [task]' : '';
  return `#${r.id}${kind} "${r.text}" — ${formatLocal(when, tz)} (${formatDelta(when.getTime() - now.getTime())})${rec}`;
}

export const remindSet: ToolDef = {
  writes: true,
  approvalLabel: (a) => `Set a reminder: "${String(a.text || '').slice(0, 100)}"${a.at ? ` at ${a.at}` : a.in_minutes ? ` in ${a.in_minutes} min` : ''}`,
  spec: {
    name: 'remind_set',
    description:
      "Schedule a reminder that the harness delivers itself at the time. Give exactly one: `at` for any clock time or day they name ('at 7pm', 'tomorrow 9am', 'Monday') as local wall time 'YYYY-MM-DD HH:mm' with the date worked out from the Now line; `in_minutes` only for spans ('in 20 minutes', 'in 2 hours'). kind 'notify' sends the text as-is (default); kind 'task' runs `text` as an instruction for you at that time (e.g. 'send them a short quote on patience') and sends your reply.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "What to remind them of, written to them (e.g. 'Drink water'), or the instruction for a task." },
        at: { type: 'string', description: "Local time 'YYYY-MM-DD HH:mm' in their timezone." },
        in_minutes: { type: 'number', description: "Minutes from now, for spans only ('in an hour' = 60). Never for a clock time." },
        repeat: {
          type: 'object',
          description: "Optional recurrence: {freq: 'minutely'|'hourly'|'daily'|'weekly'|'monthly', interval?: number, weekdays?: [0-6, Sunday=0]}",
          properties: {
            freq: { type: 'string', enum: ['minutely', 'hourly', 'daily', 'weekly', 'monthly'] },
            interval: { type: 'number' },
            weekdays: { type: 'array', items: { type: 'number' } },
          },
          required: ['freq'],
        },
        kind: { type: 'string', enum: ['notify', 'task'] },
        user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' },
      },
      required: ['text'],
    },
  },
  async run(args, ctx) {
    const text = argStr(args, 'text', 500);
    if (!text) return fail('Error: text is empty.');
    const at = argStr(args, 'at', 40);
    const mins = argNum(args, 'in_minutes');
    if (at && mins !== undefined) return fail('Error: give either `at` or `in_minutes`, not both.');
    if (!at && mins === undefined) return fail('Error: give `at` (YYYY-MM-DD HH:mm local) or `in_minutes`.');
    let fireAt: Date;
    if (at) {
      const p = parseLocalDateTime(at);
      if (!p) return fail(`Error: \`at\` must look like 2026-10-02 15:30 (got "${at}").`);
      fireAt = zonedToUtc(p.date, p.hour, p.minute, ctx.timezone);
    } else {
      if (!Number.isFinite(mins as number) || (mins as number) <= 0) return fail('Error: in_minutes must be a positive number.');
      if ((mins as number) > MAX_MINUTES) return fail('Error: that is more than five years away.');
      fireAt = new Date(ctx.now.getTime() + Math.round((mins as number) * 60_000));
    }
    if (fireAt.getTime() <= ctx.now.getTime()) {
      return fail(`Not set: ${formatLocal(fireAt, ctx.timezone)} has already passed. It is now ${formatLocal(ctx.now, ctx.timezone)} (${ctx.timezone}). If they gave a time of day without a date, set it for its next occurrence (usually tomorrow) and tell them.`);
    }
    if (fireAt.getTime() - ctx.now.getTime() > MAX_MINUTES * 60_000) return fail('Error: that is more than five years away.');
    let recurrence: Recurrence | undefined;
    if (args.repeat !== undefined && args.repeat !== null) {
      const r = validateRecurrence(args.repeat);
      if (!r) return fail("Error: repeat must be {freq: 'minutely'|'hourly'|'daily'|'weekly'|'monthly', interval?: positive whole number, weekdays?: [0-6]}.");
      if (r.freq === 'minutely' && r.interval < 5) return fail('Error: repeating more often than every 5 minutes is not allowed.');
      recurrence = r;
    }
    const kind = argStr(args, 'kind', 10) === 'task' ? 'task' : 'notify';
    const rem = ctx.store.addReminder(ctx.userKey, { kind, text, fireAt, recurrence }, ctx.now);
    ctx.effects.push({ type: 'reminder_set', reminderId: rem.id });
    pushUndo(ctx, { kind: 'reminder', ref: String(rem.id), label: text.slice(0, 60) });
    const how = kind === 'task' ? 'At that time I will run this as an instruction and send them the result.' : 'I will send it to them myself at that time.';
    return ok(`Reminder set: ${describeReminder(rem, ctx.timezone, ctx.now)}. ${how}`);
  },
};

export const remindList: ToolDef = {
  spec: {
    name: 'remind_list',
    description: 'List their pending reminders and scheduled tasks.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, ctx) {
    const list = ctx.store.listReminders(ctx.userKey);
    if (!list.length) return ok('No pending reminders.');
    return ok(list.map((r) => describeReminder(r, ctx.timezone, ctx.now)).join('\n'));
  },
};

export const remindCancel: ToolDef = {
  writes: true,
  spec: {
    name: 'remind_cancel',
    description: 'Cancel a pending reminder by #id (use remind_list to find it).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' }, user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' } },
      required: ['id'],
    },
  },
  async run(args, ctx) {
    const id = argNum(args, 'id');
    if (id === undefined || !Number.isInteger(id)) return fail('Error: id must be a whole number.');
    const r = ctx.store.cancelReminder(ctx.userKey, id);
    if (!r) return fail(`There is no pending reminder #${id}.`);
    ctx.effects.push({ type: 'reminder_cancelled', reminderId: id });
    pushUndo(ctx, { kind: 'reminder', ref: String(id), label: 'cancel ' + r.text.slice(0, 50), prev: 'cancelled' });
    return ok(`Cancelled reminder #${id} "${r.text}".`);
  },
};

export const reminderTools = [remindSet, remindList, remindCancel];
