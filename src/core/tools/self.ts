import { ToolDef } from '../types';
import { argStr, fail, ok } from './util';

export const chatSearch: ToolDef = {
  spec: {
    name: 'chat_search',
    description:
      'Search everything you and they have ever said in this chat, beyond the recent messages you can see ("what did we decide about pricing last month?", "when did I mention the inverter?").',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  async run(args, ctx) {
    const query = argStr(args, 'query', 300);
    if (!query) return fail('Error: query is empty.');
    const hits = ctx.store.searchMessages(ctx.userKey, query, 8);
    ctx.effects.push({ type: 'searched', where: 'chat', hits: hits.length });
    if (!hits.length) return ok(`Nothing in our past conversation matches "${query}".`);
    return ok(hits.map((h) => `${h.at.slice(0, 10)} ${h.role === 'user' ? 'they said' : 'you said'}: ${h.snippet}`).join('\n'));
  },
};

export const connectService: ToolDef = {
  spec: {
    name: 'connect_service',
    description: "Start connecting an outside service they sign in to themselves. Supported: 'onenote' (copies of the journal and notes to Microsoft OneNote, and searching their existing OneNote). Gives a link, or a link plus a code; pass both on with one line on what to do.",
    parameters: { type: 'object', properties: { service: { type: 'string', enum: ['onenote'] } }, required: ['service'] },
  },
  async run(args, ctx) {
    const service = argStr(args, 'service', 40).toLowerCase() || 'onenote';
    if (!ctx.ports.connectLink) return fail(`Connecting ${service} is not set up on this server.`);
    try {
      const r = await ctx.ports.connectLink(ctx.userKey, service);
      if ('error' in r) return fail(`Can't connect ${service}: ${r.error}`);
      if ('code' in r) {
        return ok(
          `Put this exact link and code in your reply (they can't see them otherwise): open ${r.url} and enter the code ${r.code} (valid ${r.expiresInMin} minutes), then sign in with the Microsoft account whose OneNote they use. You will get a message here the moment it is connected; don't claim it is connected before that.`
        );
      }
      return ok(
        `Put this exact link in your reply (they can't see it otherwise): ${r.url}\nThey open it and sign in with the Microsoft account whose OneNote they use. A message arrives here the moment it is connected; don't claim it is connected before that.${'note' in r && r.note ? `\nAlso tell them: ${r.note}` : ''}`
      );
    } catch (err) {
      return fail(`Can't connect ${service}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  },
};

export const selfTools = [chatSearch, connectService];
