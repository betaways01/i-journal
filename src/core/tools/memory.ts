import { ToolDef } from '../types';
import { isValidTimezone } from '../time';
import { argNum, argStr, fail, ok, pushUndo } from './util';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_SKILLS = 30;

export const remember: ToolDef = {
  writes: true,
  approvalLabel: (a) => `Remember: "${String(a.text || '').slice(0, 120)}"`,
  spec: {
    name: 'remember',
    description:
      "Keep something lasting about them or their world (a fact: 'has two kids, Ana and Leo', 'works night shifts as a nurse'), or a standing instruction for how you should behave ('keep replies short', 'challenge me when I make excuses'). Call it in the same turn they tell you something worth knowing next week (their work, people, plans, preferences), or say remember/don't forget — otherwise it is lost when the conversation scrolls away. Not for journal entries.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One short, self-contained sentence.' },
        kind: { type: 'string', enum: ['fact', 'instruction'], description: 'Default fact.' },
        user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' },
      },
      required: ['text'],
    },
  },
  async run(args, ctx) {
    const text = argStr(args, 'text', 500);
    if (!text) return fail('Error: text is empty.');
    const kind = argStr(args, 'kind', 20) === 'instruction' ? 'instruction' : 'fact';
    const { fact, created } = ctx.store.addFact(ctx.userKey, kind, text, ctx.now);
    if (!created) return ok(`Already kept as #${fact.id}: ${fact.text}`);
    ctx.effects.push({ type: 'fact_saved', factId: fact.id });
    pushUndo(ctx, { kind: 'fact', ref: String(fact.id), label: fact.text.slice(0, 60) });
    return ok(`Kept as ${kind} #${fact.id}: ${fact.text}`);
  },
};

export const forget: ToolDef = {
  writes: true,
  spec: {
    name: 'forget',
    description: 'Remove a kept fact or instruction by its #id (shown in your memory card) when they ask you to forget it or it is wrong.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' }, user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' } },
      required: ['id'],
    },
  },
  async run(args, ctx) {
    const id = argNum(args, 'id');
    if (id === undefined || !Number.isInteger(id)) return fail('Error: id must be a whole number.');
    const removed = ctx.store.removeFact(ctx.userKey, id);
    if (!removed) return fail(`There is no kept fact #${id}.`);
    ctx.effects.push({ type: 'fact_removed', factId: id });
    pushUndo(ctx, { kind: 'fact', ref: String(id), label: 'forget ' + removed.text.slice(0, 50), prev: JSON.stringify(removed) });
    return ok(`Forgot #${id}: ${removed.text}`);
  },
};

export const profileUpdate: ToolDef = {
  writes: true,
  spec: {
    name: 'profile_update',
    description:
      "Save their name the moment they tell you it (\"I'm Sam\", \"call me…\"), a name they give you, or their timezone (IANA name, e.g. Europe/London; work it out from the city they mention). Call it in the same turn — replying \"nice to meet you, Sam\" without saving means you will have forgotten by tomorrow.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What they want to be called.' },
        agent_name: { type: 'string', description: 'A name they gave you.' },
        timezone: { type: 'string', description: 'IANA timezone' },
        user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' },
      },
    },
  },
  async run(args, ctx) {
    const name = argStr(args, 'name', 60);
    const agentName = argStr(args, 'agent_name', 60);
    const tz = argStr(args, 'timezone', 60);
    if (!name && !agentName && !tz) return fail('Error: nothing to update.');
    if (tz && !isValidTimezone(tz)) return fail(`Error: "${tz}" is not a valid IANA timezone (e.g. Europe/London, America/New_York, Asia/Tokyo).`);
    const p = { ...ctx.profile };
    const changed: string[] = [];
    if (name && name !== p.name) {
      p.name = name;
      changed.push(`name: ${name}`);
    }
    if (agentName && agentName !== p.agentName) {
      p.agentName = agentName;
      changed.push(`your name: ${agentName}`);
    }
    if (tz && tz !== p.timezone) {
      p.timezone = tz;
      changed.push(`timezone: ${tz}`);
    }
    if (!changed.length) return ok('Already up to date.');
    ctx.store.saveProfile(ctx.userKey, p);
    Object.assign(ctx.profile, p);
    if (tz) ctx.timezone = tz;
    ctx.effects.push({ type: 'profile_updated' });
    return ok('Profile updated — ' + changed.join('; ') + '.');
  },
};

export const skillSave: ToolDef = {
  writes: true,
  approvalLabel: (a) => `Save the skill "${String(a.name || '')}": ${String(a.description || '').slice(0, 100)}`,
  spec: {
    name: 'skill_save',
    description:
      'Write down a procedure for yourself so you can follow it again later (e.g. how they like their weekly review run). Uses only the tools you already have; it cannot add new abilities.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase-with-dashes, 2-40 chars' },
        description: { type: 'string', description: 'One line: when to use it.' },
        body: { type: 'string', description: 'The steps.' },
        user_asked: { type: 'string', description: 'Their exact words, when the turn included forwarded or web content.' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  async run(args, ctx) {
    const name = argStr(args, 'name', 60).toLowerCase();
    const description = argStr(args, 'description', 160).replace(/\s+/g, ' ');
    const body = argStr(args, 'body', 4000);
    if (!SKILL_NAME.test(name)) return fail('Error: name must be 2-40 chars of lowercase letters, digits and dashes.');
    if (!description || !body) return fail('Error: description and body are required.');
    const exists = ctx.store.getSkill(ctx.userKey, name);
    if (!exists && ctx.store.listSkills(ctx.userKey).length >= MAX_SKILLS) return fail(`Error: you already have ${MAX_SKILLS} skills; update one instead.`);
    ctx.store.saveSkill(ctx.userKey, { name, description, body }, ctx.now);
    ctx.effects.push({ type: 'skill_saved', name });
    return ok(`${exists ? 'Updated' : 'Saved'} skill "${name}".`);
  },
};

export const skillRead: ToolDef = {
  spec: {
    name: 'skill_read',
    description: 'Read one of your saved procedures by name before following it.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  async run(args, ctx) {
    const name = argStr(args, 'name', 60).toLowerCase();
    const s = ctx.store.getSkill(ctx.userKey, name);
    if (!s) return fail(`No skill named "${name}".`);
    return ok(`# ${s.name}\n${s.description}\n\n${s.body}`);
  },
};

export const memoryTools = [remember, forget, profileUpdate, skillSave, skillRead];
