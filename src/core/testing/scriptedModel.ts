/** Deterministic ModelClient for loop and end-to-end tests. */
import { CompletionRequest, CompletionResult, FinishReason, ModelClient } from '../types';

export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> | string; id?: string }>;
  finishReason?: FinishReason;
  error?: Error;
  delayMs?: number;
  /** How many onText updates to emit for `text`. Default 3. */
  streamChunks?: number;
  /** Pause between streamed chunks, to exercise live-updating replies. */
  streamDelayMs?: number;
}

export type ScriptEntry = ScriptStep | ((req: CompletionRequest, callIndex: number) => ScriptStep);

export interface RecordedCall {
  messages: CompletionRequest['messages'];
  tools?: CompletionRequest['tools'];
  toolChoice?: CompletionRequest['toolChoice'];
  maxTokens?: number;
  temperature?: number;
  purpose?: CompletionRequest['purpose'];
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export class ScriptedModel implements ModelClient {
  readonly calls: RecordedCall[] = [];
  private readonly steps: ScriptEntry[];
  private readonly repeatLast: boolean;
  private readonly images: boolean;
  private seq = 0;

  constructor(steps: ScriptEntry[], opts: { repeatLast?: boolean; images?: boolean } = {}) {
    this.steps = [...steps];
    this.repeatLast = Boolean(opts.repeatLast);
    this.images = opts.images ?? true;
  }

  /** Append more steps after construction (e.g. per scenario phase). */
  push(...steps: ScriptEntry[]): void {
    this.steps.push(...steps);
  }

  get remaining(): number {
    return Math.max(0, this.steps.length - this.calls.length);
  }

  supportsImages(): boolean {
    return this.images;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const index = this.calls.length;
    this.calls.push(
      JSON.parse(
        JSON.stringify({
          messages: req.messages,
          tools: req.tools,
          toolChoice: req.toolChoice,
          maxTokens: req.maxTokens,
          temperature: req.temperature,
          purpose: req.purpose,
        })
      ) as RecordedCall
    );
    let entry = this.steps[index];
    if (entry === undefined) {
      if (this.repeatLast && this.steps.length) entry = this.steps[this.steps.length - 1];
      else throw new Error(`ScriptedModel: no step for call ${index}`);
    }
    const step = typeof entry === 'function' ? entry(req, index) : entry;
    if (req.signal?.aborted) throw abortError();
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          req.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, step.delayMs);
        const onAbort = () => {
          clearTimeout(t);
          reject(abortError());
        };
        req.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (step.error) throw step.error;
    const text = step.text ?? '';
    if (text && req.onText) {
      const n = Math.max(1, step.streamChunks ?? 3);
      const size = Math.ceil(text.length / n);
      for (let i = 1; i <= n; i++) {
        if (step.streamDelayMs && i > 1) await new Promise((r) => setTimeout(r, step.streamDelayMs));
        req.onText(text.slice(0, Math.min(text.length, i * size)));
      }
    }
    const toolCalls = (step.toolCalls || []).map((c) => ({
      id: c.id || `call_${index}_${this.seq++}`,
      name: c.name,
      arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args),
    }));
    return {
      text,
      toolCalls,
      finishReason: step.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
      usage: { promptTokens: 100, completionTokens: Math.ceil(text.length / 4), cachedTokens: 0, reasoningTokens: 0 },
      model: 'scripted',
      provider: 'scripted',
      attempts: 1,
    };
  }
}

function textOf(content: CompletionRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function lastUserText(req: Pick<CompletionRequest, 'messages'>): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 'user') return textOf(req.messages[i].content);
  }
  return '';
}

export function toolResultsIn(req: Pick<CompletionRequest, 'messages'>): Array<{ toolCallId: string; name?: string; content: string }> {
  const names = new Map<string, string>();
  const out: Array<{ toolCallId: string; name?: string; content: string }> = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') for (const c of m.tool_calls || []) names.set(c.id, c.name);
    if (m.role === 'tool' && m.tool_call_id) out.push({ toolCallId: m.tool_call_id, name: names.get(m.tool_call_id), content: textOf(m.content) });
  }
  return out;
}
