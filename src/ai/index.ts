import Anthropic from '@anthropic-ai/sdk';
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
  return textBlock ? textBlock.text : 'I couldn\'t generate a response. Let\'s try again.';
}
