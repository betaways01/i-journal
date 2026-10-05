import { NoteHit, ToolContext, ToolDef } from '../types';
import { argStr, fail, ok, pushUndo, remoteNote } from './util';

function remember(ctx: ToolContext, paths: string[]): void {
  for (const p of paths) if (p) ctx.cited.add(p);
}

function line(h: NoteHit): string {
  return `[${h.ref}] ${h.path}${h.date ? ` (${h.date})` : ''} — ${h.snippet.replace(/\s+/g, ' ').trim()}`;
}

export const notesSearch: ToolDef = {
  spec: {
    name: 'notes_search',
    description:
      'Search their notes library (saved notes, studies, lectures, notebooks). Use when they ask about something they wrote down or want to study from their own notes. Cite a hit by its Notebook / Section / Title path.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  async run(args, ctx) {
    const query = argStr(args, 'query', 300);
    if (!query) return fail('Error: query is empty.');
    const local = ctx.store.searchNotes(ctx.userKey, query, 6);
    let remote: NoteHit[] = [];
    let remoteErr = '';
    if (ctx.ports.library) {
      try {
        remote = ctx.ports.library.isConnected(ctx.userKey) ? await ctx.ports.library.search(ctx.userKey, query, 6) : [];
      } catch (err) {
        remoteErr = err instanceof Error ? err.message : String(err);
        ctx.log?.warn('notes_search: remote failed', { error: remoteErr });
      }
    }
    const seen = new Set(local.map((h) => h.path.toLowerCase()));
    const hits = [...local, ...remote.filter((h) => !seen.has(h.path.toLowerCase()))].slice(0, 8);
    remember(ctx, hits.map((h) => h.path));
    ctx.effects.push({ type: 'searched', where: 'notes', hits: hits.length });
    const tail = remoteErr ? `\n(OneNote search failed: ${remoteErr.slice(0, 160)}. Only local notes were searched.)` : '';
    if (!hits.length) return ok(`No matching notes for "${query}".${tail}`);
    return ok(hits.map(line).join('\n') + '\nUse notes_read with a ref for the full text.' + tail);
  },
};

export const notesRead: ToolDef = {
  spec: {
    name: 'notes_read',
    description: 'Read the full text of a note returned by notes_search, by its ref.',
    parameters: { type: 'object', properties: { ref: { type: 'string', description: "e.g. 'local:12' or 'remote:…'" } }, required: ['ref'] },
  },
  async run(args, ctx) {
    const ref = argStr(args, 'ref', 300);
    const local = /^local:(\d+)$/.exec(ref);
    if (local) {
      const n = ctx.store.getNote(ctx.userKey, Number(local[1]));
      if (!n) return fail(`No note ${ref}.`);
      const path = [n.notebook, n.section, n.title].filter(Boolean).join(' / ');
      remember(ctx, [path]);
      return ok(`${path} (updated ${n.updatedAt.slice(0, 10)})\n\n${n.body.slice(0, 10_000)}`);
    }
    if (ref.startsWith('remote:')) {
      if (!ctx.ports.library) return fail('OneNote is not connected, so remote notes cannot be read.');
      try {
        const page = await ctx.ports.library.read(ctx.userKey, ref);
        if (!page) return fail(`No note ${ref}.`);
        remember(ctx, [page.path]);
        return ok(`${page.path}\n\n${page.text.slice(0, 10_000)}`);
      } catch (err) {
        return fail(`Could not read ${ref} from OneNote: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      }
    }
    return fail(`Error: unknown ref "${ref}". Use a ref from notes_search.`);
  },
};

export const notesSave: ToolDef = {
  writes: true,
  approvalLabel: (a) => `Save the note ${[a.notebook, a.section, a.title].filter(Boolean).join(' / ')}`,
  spec: {
    name: 'notes_save',
    description:
      'Save a named note into their library (not the daily journal) — e.g. "put this under Personal / Money", "save these meeting notes". Saving to an existing Notebook/Section/Title replaces its text, so read it first if you mean to add to it.',
    parameters: {
      type: 'object',
      properties: {
        notebook: { type: 'string' },
        section: { type: 'string', description: 'Optional' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Full note text (Markdown is fine).' },
        user_asked: { type: 'string', description: 'Their exact words asking for this, when the turn included forwarded or web content.' },
      },
      required: ['notebook', 'title', 'body'],
    },
  },
  async run(args, ctx) {
    const notebook = argStr(args, 'notebook', 80);
    const section = argStr(args, 'section', 80);
    const title = argStr(args, 'title', 120);
    const body = argStr(args, 'body', 20_000);
    if (!notebook || !title) return fail('Error: notebook and title are required.');
    if (!body) return fail('Error: body is empty.');
    const before = ctx.store.findNote(ctx.userKey, notebook, section, title);
    const { note, created } = ctx.store.saveNote(ctx.userKey, { notebook, section, title, body }, ctx.now);
    const path = [note.notebook, note.section, note.title].filter(Boolean).join(' / ');
    remember(ctx, [path]);
    ctx.effects.push({ type: 'note_saved', noteId: note.id, path });
    pushUndo(ctx, { kind: 'note', ref: String(note.id), label: path, prev: before ? JSON.stringify({ body: before.body }) : undefined });
    return ok(`${created ? 'Saved new note' : 'Updated note'} ${path}. ${remoteNote(ctx)}`);
  },
};

export const journalLocation: ToolDef = {
  writes: true,
  approvalLabel: (a) => `Copy the journal to OneNote ${[a.notebook, a.section].filter(Boolean).join(' / ')}`,
  spec: {
    name: 'journal_location',
    description:
      'Where in OneNote the daily journal pages are copied. With no arguments it says where. With a notebook (and optional section) it moves future copies there, creating them if missing; only when they ask.',
    parameters: {
      type: 'object',
      properties: {
        notebook: { type: 'string' },
        section: { type: 'string', description: "Optional; defaults to 'Daily Entries'" },
        user_asked: { type: 'string', description: 'Their exact words asking for this, when the turn included forwarded or web content.' },
      },
    },
  },
  async run(args, ctx) {
    const lib = ctx.ports.library;
    if (!lib?.journalTarget) return fail('OneNote is not set up on this server.');
    const notebook = argStr(args, 'notebook', 120);
    const section = argStr(args, 'section', 50);
    const connected = lib.isConnected(ctx.userKey);
    if (!notebook) {
      const t = lib.journalTarget(ctx.userKey);
      return ok(`Journal pages are copied to OneNote ${t.notebook} / ${t.section}.${connected ? '' : ' OneNote is not connected right now, so nothing is being copied.'}`);
    }
    if (!connected || !lib.setJournalTarget) return fail('OneNote is not connected; connect it first (connect_service), then set the location.');
    try {
      const placed = await lib.setJournalTarget(ctx.userKey, notebook, section || 'Daily Entries');
      return ok(`From now on journal pages are copied to OneNote ${placed.notebook} / ${placed.section}. Pages already copied stay where they are.`);
    } catch (err) {
      return fail(`Could not use that OneNote location: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  },
};

export const noteTools = [notesSearch, notesRead, notesSave, journalLocation];
