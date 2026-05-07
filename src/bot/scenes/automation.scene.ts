import { Context } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/types';
import {
  buildAutomationProposal,
  AutomationProposal,
  hasAutomationSignal,
  hasExplicitAutomationSignal,
} from '../../automation/intent';
import {
  formatLocalDateTime,
  nextLocalFireAt,
  parseFlexibleTime,
  parseIntervalEveryMinutes,
  parseWeekday,
} from '../../automation/time';
import { formatRoutineSchedule } from '../../automation/labels';
import { scheduleReminder } from '../../db/reminders.repo';
import {
  createRoutine,
  findRoutineForUserByKind,
  findRoutineForUserByKindAndName,
  updateRoutine,
} from '../../db/routines.repo';
import { getUserByTelegramId, UserRow } from '../../db/users.repo';
import { computeNextRunAt } from '../../routines/schedule';
import { ConversationState } from '../../types';
import { sessionStore } from '../../state/session.store';

function automationState(userId: string, step: string, data: Record<string, unknown> = {}): ConversationState {
  return {
    userId,
    sessionType: 'automation_setup',
    currentSectionIndex: 0,
    collectedSections: [],
    ratings: {},
    conversationHistory: [],
    startedAt: new Date(),
    completed: false,
    flow: {
      name: 'automation_setup',
      step,
      data,
    },
  };
}

function setStep(userId: string, step: string, data: Record<string, unknown> = {}): void {
  sessionStore.set(userId, automationState(userId, step, data));
}

function proposalKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: 'Confirm', callback_data: 'automation_confirm' },
      { text: 'Change timing', callback_data: 'automation_change_timing' },
    ],
    [{ text: 'Cancel', callback_data: 'automation_cancel' }],
  ];
}

function proposalFromState(userId: string): AutomationProposal | null {
  const data = sessionStore.get(userId)?.flow?.data ?? {};
  const raw = data.proposal;
  if (!raw || typeof raw !== 'object') return null;
  return raw as AutomationProposal;
}

function reminderLine(proposal: AutomationProposal): string {
  if (proposal.type === 'routine') {
    return `${proposal.name} - ${formatRoutineSchedule(proposal.schedule)}`;
  }

  return `${proposal.name} - ${formatLocalDateTime(new Date(proposal.fireAtIso), proposal.timezone)}`;
}

async function showProposal(ctx: Context, proposal: AutomationProposal): Promise<void> {
  const body = proposal.type === 'routine'
    ? [
        'I can set this up as a recurring routine:',
        '',
        reminderLine(proposal),
        '',
        `Instruction: ${proposal.prompt}`,
        '',
        'I will only save this if you confirm.',
      ]
    : [
        'I can set this reminder:',
        '',
        reminderLine(proposal),
        '',
        proposal.message,
        '',
        'I will only save this if you confirm.',
      ];

  await ctx.reply(body.join('\n'), {
    reply_markup: { inline_keyboard: proposalKeyboard() },
  });
}

function upsertRoutine(userRow: UserRow, proposal: Extract<AutomationProposal, { type: 'routine' }>): void {
  const nextRunAt = computeNextRunAt(proposal.schedule, new Date());
  const config = {
    goal: proposal.goal,
    prompt: proposal.prompt,
    sourceText: proposal.sourceText,
  };
  const existing = proposal.kind === 'agent.custom_prompt'
    ? findRoutineForUserByKindAndName(userRow.id, proposal.kind, proposal.name)
    : findRoutineForUserByKind(userRow.id, proposal.kind);

  if (existing) {
    updateRoutine(existing.id, {
      name: proposal.name,
      enabled: true,
      schedule: proposal.schedule,
      config: { ...existing.config, ...config },
      nextRunAt,
    });
    return;
  }

  createRoutine({
    userId: userRow.id,
    kind: proposal.kind,
    name: proposal.name,
    schedule: proposal.schedule,
    config,
    nextRunAt,
  });
}

function saveReminder(userRow: UserRow, proposal: Extract<AutomationProposal, { type: 'reminder' }>): void {
  scheduleReminder({
    userId: userRow.id,
    kind: proposal.kind,
    fireAt: new Date(proposal.fireAtIso),
    replaceExisting: false,
    payload: {
      name: proposal.name,
      message: proposal.message,
      sourceText: proposal.sourceText,
      timezone: proposal.timezone,
    },
  });
}

async function confirmAutomation(ctx: Context, userId: string): Promise<void> {
  const userRow = getUserByTelegramId(userId);
  const proposal = proposalFromState(userId);
  if (!userRow || !proposal) {
    await ctx.reply('No automation proposal is active.');
    return;
  }

  if (proposal.type === 'routine') {
    upsertRoutine(userRow, proposal);
  } else {
    saveReminder(userRow, proposal);
  }

  sessionStore.clear(userId);
  await ctx.reply(
    [
      proposal.type === 'routine' ? 'Routine saved.' : 'Reminder saved.',
      '',
      reminderLine(proposal),
    ].join('\n')
  );
}

function retimeProposal(proposal: AutomationProposal, text: string): AutomationProposal | null {
  if (proposal.type === 'reminder') {
    const fireAt = nextLocalFireAt({ text, timezone: proposal.timezone });
    if (!fireAt) return null;
    return {
      ...proposal,
      fireAtIso: fireAt.toISOString(),
    };
  }

  const schedule = proposal.schedule;
  const intervalMinutes = parseIntervalEveryMinutes(text);
  if (intervalMinutes) {
    return {
      ...proposal,
      schedule: {
        type: 'interval',
        everyMinutes: intervalMinutes,
        timezone: schedule.timezone,
      },
    };
  }

  const time = parseFlexibleTime(text);
  const weekday = parseWeekday(text);
  if (!time && weekday === null) return null;

  if (schedule.type === 'weekly' || weekday !== null) {
    const existingTime = schedule.type === 'weekly' || schedule.type === 'daily' ? schedule.time : null;
    const nextTime = time ?? existingTime;
    if (!nextTime) return null;
    return {
      ...proposal,
      schedule: {
        type: 'weekly',
        dayOfWeek: weekday ?? (schedule.type === 'weekly' ? schedule.dayOfWeek : 1),
        time: nextTime,
        timezone: schedule.timezone,
      },
    };
  }

  if (schedule.type === 'daily' && time) {
    return {
      ...proposal,
      schedule: {
        ...schedule,
        time,
      },
    };
  }

  return null;
}

async function proposeFromText(ctx: Context, userRow: UserRow, text: string): Promise<boolean> {
  const proposal = await buildAutomationProposal({ userRow, text });
  if (!proposal) {
    await ctx.reply(
      'I can set up reminders and recurring prompts. Tell me what to send or remind you about, plus when it should happen.'
    );
    return true;
  }

  setStep(userRow.telegram_id, 'confirm', { proposal });
  await showProposal(ctx, proposal);
  return true;
}

export async function startAutomationCapture(ctx: Context, userId: string): Promise<void> {
  setStep(userId, 'capture');
  await ctx.reply(
    'Tell me what you want automated. For example: "remind me in 20 minutes to call Alex" or "send me a short motivation every morning".'
  );
}

export async function maybeStartAutomationFromText(
  ctx: Context,
  userRow: UserRow,
  text: string
): Promise<boolean> {
  if (!hasAutomationSignal(text)) return false;
  const proposal = await buildAutomationProposal({ userRow, text });
  if (!proposal) {
    if (!hasExplicitAutomationSignal(text)) return false;
    await ctx.reply(
      'I can set that up, but I need the timing. Try something like "in 20 minutes", "tomorrow at 4pm", or "every morning".'
    );
    return true;
  }

  setStep(userRow.telegram_id, 'confirm', { proposal });
  await showProposal(ctx, proposal);
  return true;
}

export async function handleAutomationSetupMessage(
  ctx: Context,
  userId: string,
  text: string
): Promise<void> {
  const state = sessionStore.get(userId);
  if (!state || state.sessionType !== 'automation_setup') return;

  const userRow = getUserByTelegramId(userId);
  if (!userRow) return;

  const step = state.flow?.step ?? 'capture';
  if (step === 'capture') {
    await proposeFromText(ctx, userRow, text);
    return;
  }

  if (step === 'change_timing') {
    const proposal = proposalFromState(userId);
    if (!proposal) {
      await ctx.reply('No automation proposal is active.');
      return;
    }

    const updated = retimeProposal(proposal, text);
    if (!updated) {
      await ctx.reply('Send a clear time or rhythm, like 07:30, tomorrow at 4pm, or every 3 hours.');
      return;
    }

    setStep(userId, 'confirm', { proposal: updated });
    await showProposal(ctx, updated);
  }
}

export async function handleAutomationSetupCallback(
  ctx: Context,
  userId: string,
  dataValue: string
): Promise<boolean> {
  if (!dataValue.startsWith('automation_')) return false;

  if (dataValue === 'automation_confirm') {
    await confirmAutomation(ctx, userId);
    return true;
  }

  if (dataValue === 'automation_change_timing') {
    const proposal = proposalFromState(userId);
    if (!proposal) {
      await ctx.reply('No automation proposal is active.');
      return true;
    }

    setStep(userId, 'change_timing', { proposal });
    await ctx.reply('What timing should I use? Example: 07:30, tomorrow at 4pm, or every 3 hours.');
    return true;
  }

  if (dataValue === 'automation_cancel') {
    sessionStore.clear(userId);
    await ctx.reply('Automation setup canceled.');
    return true;
  }

  return true;
}
