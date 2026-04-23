import Anthropic from '@anthropic-ai/sdk';
import { Context, Telegraf } from 'telegraf';
import { config } from '../config';
import { ConversationMessage } from '../types';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

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

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : "I couldn't generate a response. Let's try again.";
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

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : "I couldn't generate a response. Let's try again.";
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
