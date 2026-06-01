import Anthropic from '@anthropic-ai/sdk';
import { Context, Telegraf } from 'telegraf';
import { config } from '../config';
import { ConversationMessage } from '../types';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/** Join all text blocks, trimmed and with blanks dropped — never returns whitespace-only. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export async function sendMessage(
  systemPrompt: string,
  conversationHistory: ConversationMessage[],
  userMessage: string
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: systemPrompt,
    messages,
  });

  return extractText(response.content) || "I couldn't generate a response. Let's try again.";
}

export interface CompanionTurnInput {
  cacheableCore: string;
  volatileContext: string;
  conversationHistory: ConversationMessage[];
  userMessage: string;
}

export async function companionTurn(input: CompanionTurnInput): Promise<string> {
  const { cacheableCore, volatileContext, conversationHistory, userMessage } = input;

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: cacheableCore,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: volatileContext,
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: systemBlocks,
    messages,
  });

  return extractText(response.content) || "I couldn't generate a response. Let's try again.";
}

/**
 * A tool the companion can actually invoke. `run` performs the real side effect
 * (saving an entry, scheduling a reminder, etc.) and returns a short text result
 * that is fed back to the model so it can speak truthfully about what happened.
 */
export interface CompanionTool {
  definition: Anthropic.Tool;
  run: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentRunInput {
  cacheableCore: string;
  volatileContext: string;
  messages: Anthropic.MessageParam[];
  tools: CompanionTool[];
  maxSteps?: number;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
}

export interface AgentRunResult {
  text: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  /** Full message list including appended assistant tool-use turns and tool results. */
  finalMessages: Anthropic.MessageParam[];
}

/**
 * The agent loop. Runs the model with tools, executes any tool calls it makes,
 * feeds the results back, and repeats until the model returns a plain text reply.
 * This is what gives the companion hands: when it decides to save a journal, set a
 * reminder, or change a setting, it calls a tool and gets a real result — instead of
 * emitting prose that downstream regexes have to guess at.
 */
const AGENT_FALLBACK_TEXT = "I'm here — say more whenever you're ready.";

export async function runCompanionAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const { cacheableCore, volatileContext, tools, maxSteps = 6 } = input;
  const messages: Anthropic.MessageParam[] = [...input.messages];
  const toolDefs = tools.map((t) => t.definition);
  const toolMap = new Map(tools.map((t) => [t.definition.name, t]));
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: cacheableCore, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatileContext },
  ];

  let finalText = '';

  for (let step = 0; step < maxSteps; step++) {
    // On the final allowed step, drop tools so the model is forced to produce a
    // closing text reply rather than leaving a tool call dangling.
    const allowTools = step < maxSteps - 1 && toolDefs.length > 0;

    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemBlocks,
      ...(allowTools ? { tools: toolDefs } : {}),
      messages,
    });

    const textParts = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean);
    if (textParts.length) finalText = textParts.join('\n\n');

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    if (!allowTools || response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text: finalText || AGENT_FALLBACK_TEXT, toolCalls, finalMessages: messages };
    }

    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const toolInput = (use.input ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: use.name, input: toolInput });
      try {
        input.onToolUse?.(use.name, toolInput);
      } catch {
        // observer must never break the loop
      }

      const tool = toolMap.get(use.name);
      let content: string;
      if (!tool) {
        content = `Error: unknown tool "${use.name}".`;
      } else {
        try {
          content = await tool.run(toolInput);
        } catch (err) {
          content = `Error running ${use.name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content });
    }

    messages.push({ role: 'user', content: results });
  }

  return { text: finalText || AGENT_FALLBACK_TEXT, toolCalls, finalMessages: messages };
}

export async function withTyping<T>(
  ctx: Context | Telegraf,
  chatId: number | string,
  fn: () => Promise<T>
): Promise<T> {
  const telegram = (ctx as Context | Telegraf).telegram;

  const send = () => {
    telegram.sendChatAction(chatId, 'typing').catch(() => {});
  };

  send();
  const interval = setInterval(send, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}
