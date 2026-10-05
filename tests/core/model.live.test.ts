import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createModelClient, providersFromEnv } from '../../src/core/model';
import { ChatMessage, ToolSpec } from '../../src/core/types';

const LIVE = process.env.LIVE === '1';
if (LIVE) dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });

const opts = { skip: LIVE ? false : 'set LIVE=1 to run against the real model' };
const client = () => createModelClient({ providers: providersFromEnv() });

test('live: streamed plain answer', opts, async () => {
  const seen: string[] = [];
  const t0 = Date.now();
  const r = await client().complete({
    messages: [{ role: 'user', content: 'In three short sentences, explain why the sky is blue.' }],
    maxTokens: 4096,
    onText: (t) => seen.push(t),
  });
  console.log(`  plain: ${Date.now() - t0}ms, ${seen.length} onText updates, usage ${JSON.stringify(r.usage)}`);
  assert.ok(r.text.length > 40);
  assert.ok(seen.length > 1, 'streamed in more than one piece');
  assert.equal(seen[seen.length - 1], r.text);
});

test('live: two-round tool loop', opts, async () => {
  const tools: ToolSpec[] = [
    {
      name: 'get_weather',
      description: 'Current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ];
  const messages: ChatMessage[] = [{ role: 'user', content: 'What is the weather in Porto right now? Use the tool.' }];
  const c = client();
  const t0 = Date.now();
  const r1 = await c.complete({ messages, tools, maxTokens: 4096 });
  assert.equal(r1.toolCalls.length >= 1, true, 'model called the tool');
  assert.equal(r1.toolCalls[0].name, 'get_weather');
  assert.match(JSON.parse(r1.toolCalls[0].arguments).city, /porto/i);
  messages.push({ role: 'assistant', content: r1.text, tool_calls: r1.toolCalls });
  for (const call of r1.toolCalls) messages.push({ role: 'tool', tool_call_id: call.id, content: 'Porto: 27°C, light rain, wind 9 km/h.' });
  const r2 = await c.complete({ messages, tools, maxTokens: 4096 });
  console.log(`  tools: ${Date.now() - t0}ms; final: ${r2.text.slice(0, 120)}`);
  assert.equal(r2.toolCalls.length, 0);
  assert.match(r2.text, /27/);
});

const handwriting = path.join(__dirname, '../fixtures/handwritten-note.jpg');
test('live: reads handwriting from an image', opts, async () => {
  const file = handwriting;
  const data = fs.readFileSync(file).toString('base64');
  const t0 = Date.now();
  const r = await client().complete({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read the heading on this handwritten page. Reply with the heading only.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + data } },
        ],
      },
    ],
    maxTokens: 4096,
  });
  console.log(`  vision: ${Date.now() - t0}ms -> ${r.text.slice(0, 80)}`);
  assert.match(r.text, /garden\s+plans/i);
});

test('live: small max_tokens still yields text thanks to the empty-reply guard', opts, async () => {
  const r = await client().complete({
    messages: [{ role: 'user', content: 'A train leaves at 14:35 and arrives at 17:10. How long is the trip? Answer briefly.' }],
    maxTokens: 150,
  });
  console.log(`  guard: attempts ${r.attempts}, finish ${r.finishReason}, text: ${r.text.slice(0, 80)}`);
  assert.ok(r.text.trim().length > 0);
});
