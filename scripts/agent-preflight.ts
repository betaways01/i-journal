/**
 * Agent preflight — exercises the adaptive setup path with real Anthropic calls
 * and a disposable SQLite database.
 *
 * Run: npm run preflight:agent
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ijournal-agent-preflight-'));
process.env.DB_PATH = path.join(tmpDir, 'preflight.db');
process.env.TIMEZONE = 'Africa/Nairobi';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? 'preflight-fake-token';

type ReplyRecord = {
  text: string;
  extra?: unknown;
};

type FakeContext = {
  from: {
    id: number;
    first_name: string;
    username?: string;
  };
  chat: {
    id: number;
    type: 'private';
  };
  telegram: {
    sendChatAction: () => Promise<void>;
  };
  replies: ReplyRecord[];
  reply: (text: string, extra?: unknown) => Promise<void>;
};

function makeCtx(telegramId: string, firstName: string): FakeContext {
  const numericId = Number(telegramId);
  const ctx: FakeContext = {
    from: {
      id: numericId,
      first_name: firstName,
      username: `${firstName.toLowerCase()}_preflight`,
    },
    chat: {
      id: numericId,
      type: 'private',
    },
    telegram: {
      sendChatAction: async () => {},
    },
    replies: [],
    reply: async (text: string, extra?: unknown) => {
      ctx.replies.push({ text: String(text), extra });
    },
  };
  return ctx;
}

function dumpNewReplies(ctx: FakeContext, startIndex: number): void {
  for (const reply of ctx.replies.slice(startIndex)) {
    const oneLine = reply.text.replace(/\s+/g, ' ').slice(0, 260);
    console.log(`    bot: ${oneLine}`);
  }
}

function assert(cond: unknown, label: string): void {
  if (!cond) {
    throw new Error(label);
  }
  console.log(`  OK ${label}`);
}

function titles(profile: { sections: Array<{ title: string }> }): string[] {
  return profile.sections.map((section) => section.title);
}

function includesTitle(profile: { sections: Array<{ title: string }> }, title: string): boolean {
  return titles(profile).some((value) => value.toLowerCase() === title.toLowerCase());
}

async function run(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for agent preflight.');
  }

  // Require after env setup so the app binds to the disposable DB.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDb, closeDb } = require('../src/db') as typeof import('../src/db');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { upsertUser, getUserByTelegramId } = require('../src/db/users.repo') as typeof import('../src/db/users.repo');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getProfileForUser } = require('../src/db/profile.repo') as typeof import('../src/db/profile.repo');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { listWorkspaceDocs } = require('../src/db/agentWorkspace.repo') as typeof import('../src/db/agentWorkspace.repo');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { findRoutineForUserByKind } = require('../src/db/routines.repo') as typeof import('../src/db/routines.repo');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sessionStore } = require('../src/state/session.store') as typeof import('../src/state/session.store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    startOnboarding,
    handleOnboardingMessage,
    handleOnboardingCallback,
  } = require('../src/bot/scenes/onboarding.scene') as typeof import('../src/bot/scenes/onboarding.scene');

  getDb();
  console.log(`Agent preflight DB: ${process.env.DB_PATH}`);

  async function scenario(params: {
    label: string;
    telegramId: string;
    firstName: string;
    turns: string[];
    check: (data: {
      profile: NonNullable<ReturnType<typeof getProfileForUser>>;
      userDoc: string;
      identityDoc: string;
      userRow: NonNullable<ReturnType<typeof getUserByTelegramId>>;
    }) => void;
  }): Promise<void> {
    console.log(`\n# ${params.label}`);
    upsertUser({ telegramId: params.telegramId, firstName: params.firstName, isOwner: false });
    const ctx = makeCtx(params.telegramId, params.firstName);

    let seen = ctx.replies.length;
    await startOnboarding(ctx as never, params.telegramId);
    dumpNewReplies(ctx, seen);

    for (const turn of params.turns) {
      console.log(`    user: ${turn}`);
      seen = ctx.replies.length;
      await handleOnboardingMessage(ctx as never, params.telegramId, turn);
      dumpNewReplies(ctx, seen);
    }

    const state = sessionStore.get(params.telegramId);
    assert(state?.flow?.step === 'final_confirm', 'setup reached final confirmation');

    seen = ctx.replies.length;
    await handleOnboardingCallback(ctx as never, params.telegramId, 'onb_confirm');
    dumpNewReplies(ctx, seen);

    const userRow = getUserByTelegramId(params.telegramId);
    assert(userRow, 'user row exists after setup');
    assert(userRow!.onboarding_complete === 1, 'onboarding marked complete');

    const profile = getProfileForUser(userRow!.id);
    assert(profile, 'profile saved');

    const docs = listWorkspaceDocs(userRow!.id);
    const byKey = new Map(docs.map((doc) => [doc.key, doc.content]));
    const userDoc = byKey.get('USER.md') ?? '';
    const identityDoc = byKey.get('IDENTITY.md') ?? '';
    assert(userDoc.includes('# USER.md'), 'USER.md saved');
    assert(identityDoc.includes('# IDENTITY.md'), 'IDENTITY.md saved');

    params.check({ profile: profile!, userDoc, identityDoc, userRow: userRow! });
  }

  await scenario({
    label: 'messy name, alias, dotted natural times',
    telegramId: '910000001',
    firstName: 'Francis',
    turns: [
      'King Kang, or sometime Francis. Track Work, Family, Faith, Personal. Morning at 9.30, evening at 8.30.',
    ],
    check: ({ profile, userDoc }) => {
      assert(profile.name === 'King Kang', `preferred name is King Kang (got ${profile.name})`);
      assert(userDoc.includes('Aliases: Francis'), 'Francis stored as alias, not glued into preferred name');
      assert(profile.morningTime === '09:30', `morning time 09:30 (got ${profile.morningTime})`);
      assert(profile.eveningTime === '20:30', `evening time 20:30 (got ${profile.eveningTime})`);
      for (const title of ['Work', 'Family', 'Faith', 'Personal']) {
        assert(includesTitle(profile, title), `area captured: ${title}`);
      }
    },
  });

  await scenario({
    label: 'user names the companion separately from self',
    telegramId: '910000002',
    firstName: 'Hilda',
    turns: [
      'Call yourself Nia. My name is Hilda but call me Hils.',
      'Keep track of God, Family, and Personal Life. Check in morning around 6 and evening at 9pm.',
    ],
    check: ({ profile, userDoc, identityDoc }) => {
      assert(profile.name === 'Hils', `preferred name is Hils (got ${profile.name})`);
      assert(userDoc.includes('Given name: Hilda'), 'given name Hilda stored in USER.md');
      assert(userDoc.includes('Nicknames: Hils'), 'nickname Hils stored in USER.md');
      assert(identityDoc.includes('Agent name: Nia'), 'agent name Nia stored in IDENTITY.md');
      assert(profile.morningTime === '06:00', `morning time 06:00 (got ${profile.morningTime})`);
      assert(profile.eveningTime === '21:00', `evening time 21:00 (got ${profile.eveningTime})`);
      for (const title of ['God', 'Family', 'Personal Life']) {
        assert(includesTitle(profile, title), `area captured: ${title}`);
      }
    },
  });

  await scenario({
    label: 'user asks for a helpful daily learning routine',
    telegramId: '910000003',
    firstName: 'Mara',
    turns: [
      'I am Mara. Track Work and Learning. Morning 7am, evening 9pm. Also teach me a useful conversation word every morning.',
    ],
    check: ({ profile, userRow }) => {
      assert(profile.name === 'Mara', `preferred name is Mara (got ${profile.name})`);
      assert(profile.morningTime === '07:00', `morning time 07:00 (got ${profile.morningTime})`);
      assert(profile.eveningTime === '21:00', `evening time 21:00 (got ${profile.eveningTime})`);
      const routine =
        findRoutineForUserByKind(userRow.id, 'learning.word_of_day') ??
        findRoutineForUserByKind(userRow.id, 'agent.custom_prompt');
      assert(routine, 'daily learning routine created from natural request');
    },
  });

  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\nAgent preflight passed.');
}

run().catch((error) => {
  console.error('\nAgent preflight failed:');
  console.error(error);
  process.exit(1);
});
