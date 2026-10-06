import { ToolContext, ToolDef } from '../types';
import { formatLocal, isIsoDate, localParts, resolveDay, shiftDate, weekdayOf } from '../time';
import { argBool, argStr, fail, ok, ownWords, pushUndo, quoteAppears, recentUserMedia, remoteNote, renderDay, todayOf, copyStatus } from './util';

const PAGE_CAP = 6000;

function dayLabel(date: string): string {
  return `${weekdayOf(date)} ${date}`;
}

/**
 * The page an open session writes to: the session's own day if it was opened today (including a
 * catch-up session for a past day), or yesterday's session until 05:00. A session left open from
 * an earlier day otherwise rolls onto today.
 */
export function sessionDate(ctx: Pick<ToolContext, 'state' | 'now' | 'timezone'>): string {
  const today = localParts(ctx.now, ctx.timezone).date;
  const s = ctx.state;
  if (s.journalOpen && s.journalDate) {
    const openedOn = s.journalOpenedAt ? localParts(new Date(s.journalOpenedAt), ctx.timezone).date : undefined;
    if (openedOn === today) return s.journalDate;
    if (s.journalDate === shiftDate(today, -1) && localParts(ctx.now, ctx.timezone).hour < 5) return s.journalDate;
  }
  return today;
}

export const journalOpen: ToolDef = {
  writes: true,
  spec: {
    name: 'journal_open',
    description:
      "Open a journal session: from now on, what they share about their day goes on the day's page. Use when they ask to journal or start telling you about their day with the intent of journaling.",
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "Optional: 'today', 'yesterday' or YYYY-MM-DD. Defaults to today; between midnight and 05:00 it defaults to the day that just ended." },
      },
    },
  },
  async run(args, ctx) {
    const today = todayOf(ctx);
    const hour = localParts(ctx.now, ctx.timezone).hour;
    const raw = argStr(args, 'date', 20);
    const date = raw ? resolveDay(raw, ctx.now, ctx.timezone) : hour < 5 ? shiftDate(today, -1) : today;
    if (!date) return fail(`Error: date must be 'today', 'yesterday' or YYYY-MM-DD (got "${raw}").`);
    if (date > today) return fail('Error: cannot open a journal for a future date.');
    if (ctx.state.journalOpen && ctx.state.journalDate === date) {
      return ok(`The journal is already open for ${dayLabel(date)}.`);
    }
    ctx.state.journalOpen = true;
    ctx.state.journalOpenedAt = ctx.now.toISOString();
    ctx.state.journalDate = date;
    ctx.effects.push({ type: 'journal_opened', date });
    const day = ctx.store.getDay(ctx.userKey, date);
    const parts = [`Journal open for ${dayLabel(date)}.`];
    if (!raw && hour < 5 && date !== today) parts.push("It's past midnight, so this is the day that just ended. Pass date 'today' to journal_write if they mean the new day.");
    parts.push(day && day.entries.length ? `Already on the page:\n${renderDay(day).slice(0, PAGE_CAP)}` : 'The page is empty so far.');
    if (ctx.state.pendingOffer) parts.push(`Earlier you offered to put this on the page: "${ctx.state.pendingOffer.text}". Only add it if they want it.`);
    return ok(parts.join('\n'));
  },
};

export const journalWrite: ToolDef = {
  writes: true,
  approvalLabel: (a) => `Put this on your journal page: "${String(a.text || '').slice(0, 120)}"`,
  spec: {
    name: 'journal_write',
    description:
      "Add an entry to a day's journal page. Use the person's own words, lightly cleaned, first person. Works when the journal session is open, when they accepted your offer to put something on the page, or when they explicitly asked to save/journal this (then pass user_asked). Never use it for questions to you, greetings, requests, or your own text.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The entry, in their words.' },
        date: { type: 'string', description: "Optional: 'today', 'yesterday' or YYYY-MM-DD. Defaults to the open session's day." },
        attach_media: { type: 'boolean', description: 'Attach the photo/voice note they just sent (or the most recent one) to this entry.' },
        user_asked: { type: 'string', description: "Their exact words asking you to save this (e.g. 'journal this'). Required when the journal is closed and you did not offer first." },
      },
      required: ['text'],
    },
  },
  async run(args, ctx) {
    const text = argStr(args, 'text', 8000);
    const media = argBool(args, 'attach_media') ? recentUserMedia(ctx) : [];
    if (!text && !media.length) return fail('Not saved: the entry is empty.');

    const today = todayOf(ctx);
    const rawDate = argStr(args, 'date', 20);
    let date: string;
    if (rawDate) {
      const d = resolveDay(rawDate, ctx.now, ctx.timezone);
      if (!d) return fail(`Not saved: date must be 'today', 'yesterday' or YYYY-MM-DD (got "${rawDate}").`);
      date = d;
    } else {
      date = sessionDate(ctx);
    }
    if (date > today) return fail(`Not saved: ${date} is in the future.`);

    const s = ctx.state;
    const asked = argStr(args, 'user_asked', 300);
    const askedOk = Boolean(asked) && quoteAppears(asked, [ownWords(ctx.inbound), ctx.inbound.target?.text, ctx.inbound.target?.quote].filter(Boolean).join('\n'));
    const allowed = s.journalOpen || Boolean(s.pendingOffer) || askedOk || Boolean(ctx.approved);
    if (!allowed) {
      s.pendingOffer = { text: text || '(media)', date, at: ctx.now.toISOString() };
      const page = date === today ? "today's page" : `${dayLabel(date)}'s page`;
      if (asked) {
        return fail(
          `Not saved: "${asked}" is not in their message this turn. user_asked must quote their exact words. If they did ask you to save it, call journal_write again quoting them exactly; if not, ask once whether they'd like it on ${page}.`
        );
      }
      return fail(
        `Not saved yet: the journal session is closed, so a save needs their go-ahead. If their message asks you to save, journal, keep, or put this on the page, call journal_write again right away with user_asked set to their exact words (for example "put it on the page") — no need to open the journal. Otherwise reply to them first, then ask once whether they'd like it on ${page}.`
      );
    }

    const existing = ctx.store.getDay(ctx.userKey, date);
    const last = existing?.entries[existing.entries.length - 1];
    if (last && !media.length && last.text.trim().toLowerCase() === text.trim().toLowerCase()) {
      return fail(`Not saved again: that exact entry is already the last one on ${dayLabel(date)}.`);
    }

    const { day, entry } = ctx.store.addEntry(ctx.userKey, date, {
      text,
      media,
      at: ctx.now,
      localTime: localParts(ctx.now, ctx.timezone).time,
    });
    if (s.journalOpen && s.journalDate !== date && !rawDate && date === today) s.journalDate = today;
    s.pendingOffer = undefined;
    ctx.effects.push({ type: 'journal_saved', date, entryId: entry.id, media: media.length });
    pushUndo(ctx, { kind: 'journal_entry', ref: String(entry.id), date, label: (text || 'media').slice(0, 60) });
    const mediaNote = media.length ? ` with ${media.length} attachment${media.length > 1 ? 's' : ''}` : '';
    const dateNote = date === today ? `today's page (${dayLabel(date)})` : `${dayLabel(date)}'s page`;
    return ok(`Saved to ${dateNote}${mediaNote}. That page now has ${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'}. ${remoteNote(ctx)}`);
  },
};

export const journalClose: ToolDef = {
  writes: true,
  spec: {
    name: 'journal_close',
    description:
      "Close the journal session when they're done (\"that's it\", \"good night\", \"done\" while journaling). Always close when they say so, even if the page is empty: closing is what stops later chat from landing on the page. Optionally store a short reflection on the day, written only from what is on the page — never invented. Returns the page.",
    parameters: {
      type: 'object',
      properties: {
        reflection: { type: 'string', description: "2-4 sentences reflecting the day, only from the page's entries. Omit if there is too little." },
      },
    },
  },
  async run(args, ctx) {
    const s = ctx.state;
    const date = s.journalOpen ? s.journalDate || todayOf(ctx) : todayOf(ctx);
    const day = ctx.store.getDay(ctx.userKey, date);
    const wasOpen = s.journalOpen;
    if (!day || !day.entries.length) {
      s.journalOpen = false;
      s.journalDate = undefined;
      if (wasOpen) ctx.effects.push({ type: 'journal_closed', date, wrapped: false });
      return ok(`${wasOpen ? 'Journal closed.' : 'The journal was not open.'} Nothing was written on ${dayLabel(date)}, so there is nothing to wrap and no page was created.`);
    }
    const reflection = argStr(args, 'reflection', 2000);
    pushUndo(ctx, {
      kind: 'journal_close',
      ref: date,
      date,
      label: 'close ' + date,
      prev: JSON.stringify({ reflection: day.reflection ?? null, closedAt: day.closedAt ?? null, wasOpen, journalDate: s.journalDate ?? null }),
    });
    const updated = reflection ? ctx.store.setReflection(ctx.userKey, date, reflection, ctx.now) : day;
    s.journalOpen = false;
    s.journalDate = undefined;
    ctx.effects.push({ type: 'journal_closed', date, wrapped: Boolean(reflection) });
    const page = renderDay(updated || day).slice(0, PAGE_CAP);
    return ok(`${wasOpen ? 'Journal closed' : 'Wrapped'} for ${dayLabel(date)}${reflection ? ' with your reflection' : ''}. ${remoteNote(ctx)}\n\n${page}`);
  },
};

export const journalRead: ToolDef = {
  spec: {
    name: 'journal_read',
    description: "Read journal pages: one day (date) or a range (from/to). Use when they ask what they wrote on a day, how a day went, or to compare days.",
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "'today', 'yesterday' or YYYY-MM-DD" },
        from: { type: 'string', description: 'YYYY-MM-DD, start of a range' },
        to: { type: 'string', description: 'YYYY-MM-DD, end of a range (inclusive)' },
      },
    },
  },
  async run(args, ctx) {
    const from = argStr(args, 'from', 20);
    const to = argStr(args, 'to', 20);
    if (from || to) {
      const f = from || to;
      const t = to || from;
      if (!isIsoDate(f) || !isIsoDate(t)) return fail('Error: from/to must be YYYY-MM-DD.');
      const [lo, hi] = f <= t ? [f, t] : [t, f];
      const days = ctx.store.listDays(ctx.userKey, { from: lo, to: hi, limit: 62 });
      if (!days.length) return ok(`Nothing was written between ${lo} and ${hi}.`);
      let out = '';
      let shown = 0;
      for (const d of [...days].reverse()) {
        const page = ctx.store.getDay(ctx.userKey, d.date);
        if (!page) continue;
        const block = renderDay(page) + '\n\n';
        if (out.length + block.length > PAGE_CAP) break;
        out += block;
        shown++;
      }
      const more = days.length > shown ? `\n(${days.length - shown} more day(s) in range not shown; narrow the range.)` : '';
      return ok(out.trim() + more);
    }
    const raw = argStr(args, 'date', 20);
    const date = resolveDay(raw || 'today', ctx.now, ctx.timezone);
    if (!date) return fail(`Error: date must be 'today', 'yesterday' or YYYY-MM-DD (got "${raw}").`);
    const day = ctx.store.getDay(ctx.userKey, date);
    if (!day || (!day.entries.length && !day.reflection)) return ok(`Nothing is written on ${dayLabel(date)}.`);
    const copy = ctx.ports.library?.isConnected(ctx.userKey) ? `\n\n${copyStatus(day, ctx.timezone)}` : '';
    return ok(renderDay(day).slice(0, PAGE_CAP) + copy);
  },
};

export const journalSearch: ToolDef = {
  spec: {
    name: 'journal_search',
    description: 'Search every journal entry they have written. Use for "when did I last…", "what did I write about…", or to find a day by topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Key words to look for.' },
        from: { type: 'string', description: 'Optional YYYY-MM-DD lower bound' },
        to: { type: 'string', description: 'Optional YYYY-MM-DD upper bound' },
      },
      required: ['query'],
    },
  },
  async run(args, ctx) {
    const query = argStr(args, 'query', 300);
    if (!query) return fail('Error: query is empty.');
    const from = argStr(args, 'from', 20);
    const to = argStr(args, 'to', 20);
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return fail('Error: from/to must be YYYY-MM-DD.');
    const hits = ctx.store.searchJournal(ctx.userKey, query, { from: from || undefined, to: to || undefined, limit: 8 });
    ctx.effects.push({ type: 'searched', where: 'journal', hits: hits.length });
    if (!hits.length) return ok(`No journal entries match "${query}".`);
    return ok(hits.map((h) => `${h.weekday.slice(0, 3)} ${h.date} ${h.localTime} — ${h.snippet}`).join('\n'));
  },
};

export function journalStatusLine(ctx: Pick<ToolContext, 'state' | 'store' | 'userKey' | 'now' | 'timezone'>): string {
  const s = ctx.state;
  if (!s.journalOpen) return 'Journal: closed (chat does not write to the journal).';
  const date = s.journalDate || localParts(ctx.now, ctx.timezone).date;
  const day = ctx.store.getDay(ctx.userKey, date);
  const opened = s.journalOpenedAt ? ` since ${formatLocal(new Date(s.journalOpenedAt), ctx.timezone)}` : '';
  return `Journal: OPEN for ${dayLabel(date)}${opened} — ${day?.entries.length || 0} entr${day?.entries.length === 1 ? 'y' : 'ies'} so far.`;
}

export const journalTools = [journalOpen, journalWrite, journalClose, journalRead, journalSearch];
