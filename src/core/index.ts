import { compactIfNeeded, runTurn } from './loop';
import { Deps, TurnHooks, TurnRecord, TurnRequest, TurnResult } from './types';

export interface Core {
  readonly deps: Deps;
  runTurn(req: TurnRequest, hooks?: TurnHooks): Promise<TurnResult>;
  /** Call after a reply has been delivered, inside the same per-user queue. */
  compact(userKey: string): Promise<boolean>;
}

const short = (v: unknown, max: number): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

/** Every turn leaves one row in the turn log (and one per issue the model reported). Never throws. */
function recordTurn(deps: Deps, req: TurnRequest, startedAt: Date, ms: number, r: TurnResult | null, error?: unknown): number | undefined {
  try {
    const row: Omit<TurnRecord, 'id' | 'feedback' | 'feedbackScore'> = {
      userKey: req.userKey,
      at: startedAt.toISOString(),
      kind: req.inbound.kind,
      ms,
      rounds: r?.rounds ?? 0,
      tools: (r?.trace ?? []).map((t) => ({ tool: t.tool, ok: t.ok, ms: t.ms, args: short(t.args, 300), ...(t.ok ? {} : { error: short(t.result.split('\n')[0], 300) }) })),
      corrections: r?.corrections ?? [],
      effects: (r?.effects ?? []).map((e) => e.type),
      degraded: r?.degraded,
      silent: r?.silent ?? false,
      model: r?.model,
      promptTokens: r?.usage.promptTokens ?? 0,
      completionTokens: r?.usage.completionTokens ?? 0,
      cachedTokens: r?.usage.cachedTokens ?? 0,
      replyChars: r?.reply.length ?? 0,
      error: error ? short(error instanceof Error ? error.stack || error.message : String(error), 2000) : undefined,
    };
    const id = deps.store.recordTurn(row);
    for (const e of r?.effects ?? []) if (e.type === 'issue_reported') deps.store.addIssue(req.userKey, e.kind, e.text, startedAt, id);
    return id;
  } catch (err) {
    deps.log?.warn('turn log write failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

export function createCore(deps: Deps): Core {
  return {
    deps,
    async runTurn(req, hooks) {
      const startedAt = req.now ?? new Date();
      const t0 = Date.now();
      try {
        const r = await runTurn(deps, req, hooks);
        r.ms = Date.now() - t0;
        r.turnId = recordTurn(deps, req, startedAt, r.ms, r);
        return r;
      } catch (err) {
        recordTurn(deps, req, startedAt, Date.now() - t0, null, err);
        throw err;
      }
    },
    compact: (userKey) => compactIfNeeded(deps, userKey),
  };
}

export * from './types';
export { runTurn, compactIfNeeded, describeEffects } from './loop';
export { SqliteStore, openCoreDb, defaultState } from './store';
export { createModelClient, providersFromEnv } from './model';
export { renderDay } from './tools/util';
export { describeReminder } from './tools/reminders';
export * as time from './time';
