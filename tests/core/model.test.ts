import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { createModelClient, ProviderConfig, providersFromEnv, serializeMessages } from '../../src/core/model';
import { lastUserText, ScriptedModel, toolResultsIn } from '../../src/core/testing/scriptedModel';
import { ChatMessage, CompletionRequest, ModelUnavailableError } from '../../src/core/types';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void | Promise<void>;

interface Fake {
  url: string;
  seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function fakeProvider(handlers: Handler[]): Promise<Fake> {
  const seen: Fake['seen'] = [];
  let i = 0;
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    seen.push({ path: req.url || '', headers: req.headers, body });
    const h = handlers[Math.min(i++, handlers.length - 1)];
    try {
      await h(req, res, body);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

const delta = (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason = 'stop') => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 7 } } };

function sse(res: http.ServerResponse, chunks: unknown[], done = true): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}

const KEY = 'sk-test-SECRET-123';
const prov = (url: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ name: 'p1', baseUrl: url, apiKey: KEY, model: 'm1', images: true, ...extra });
const user = (text: string): CompletionRequest => ({ messages: [{ role: 'user', content: text }] });

function client(providers: ProviderConfig[], over: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  const c = createModelClient({
    providers,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 2000,
    totalTimeoutMs: 5000,
    ...over,
  });
  return { c, sleeps };
}

test('streams text, calls onText progressively, maps usage', async () => {
  const f = await fakeProvider([(_q, res) => sse(res, [delta('Hel'), delta('lo, '), delta('Sam.'), finish(), usageChunk])]);
  try {
    const { c } = client([prov(f.url)]);
    const seen: string[] = [];
    const r = await c.complete({ ...user('hi'), onText: (t) => seen.push(t) });
    assert.equal(r.text, 'Hello, Sam.');
    assert.deepEqual(seen, ['Hel', 'Hello, ', 'Hello, Sam.']);
    assert.equal(r.finishReason, 'stop');
    assert.deepEqual(r.usage, { promptTokens: 50, completionTokens: 20, cachedTokens: 30, reasoningTokens: 7 });
    assert.equal(r.attempts, 1);
    assert.equal(r.provider, 'p1');
    assert.equal(f.seen[0].path, '/chat/completions');
    assert.equal(f.seen[0].headers.authorization, 'Bearer ' + KEY);
    assert.equal(f.seen[0].body.stream, true);
    assert.deepEqual(f.seen[0].body.stream_options, { include_usage: true });
  } finally {
    await f.close();
  }
});

test('reasoning deltas never reach onText or text', async () => {
  const f = await fakeProvider([
    (_q, res) =>
      sse(res, [
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking hard' } }] },
        { choices: [{ index: 0, delta: { reasoning: 'more' } }] },
        delta('Answer.'),
        finish(),
      ]),
  ]);
  try {
    const { c } = client([prov(f.url)]);
    const seen: string[] = [];
    const r = await c.complete({ ...user('q'), onText: (t) => seen.push(t) });
    assert.equal(r.text, 'Answer.');
    assert.deepEqual(seen, ['Answer.']);
  } finally {
    await f.close();
  }
});

test('assembles parallel tool calls from fragments split mid-JSON and mid-UTF-8', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'remind_set', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text": "Kunywa ' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'journal_search', arguments: '{"que' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'maji ☕", "in_minutes": 5}' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: 'ry": "Jordan"}' } }] } }] },
        finish('tool_calls'),
      ];
      const bytes = Buffer.from(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', 'utf8');
      const cup = bytes.indexOf(Buffer.from('☕', 'utf8'));
      // split inside the 3-byte coffee cup and inside a line
      res.write(bytes.subarray(0, cup + 1));
      res.write(bytes.subarray(cup + 1, cup + 2));
      res.write(bytes.subarray(cup + 2, cup + 40));
      res.end(bytes.subarray(cup + 40));
    },
  ]);
  try {
    const { c } = client([prov(f.url)]);
    const r = await c.complete(user('q'));
    assert.equal(r.finishReason, 'tool_calls');
    assert.deepEqual(r.toolCalls.map((t) => t.name), ['remind_set', 'journal_search']);
    assert.deepEqual(r.toolCalls.map((t) => t.id), ['call_a', 'call_b']);
    assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { text: 'Kunywa maji ☕', in_minutes: 5 });
    assert.deepEqual(JSON.parse(r.toolCalls[1].arguments), { query: 'Jordan' });
  } finally {
    await f.close();
  }
});

test('index-less tool calls, repeated ids, missing ids, empty names', async () => {
  const f = await fakeProvider([
    (_q, res) =>
      sse(res, [
        { choices: [{ index: 0, delta: { tool_calls: [{ id: 'x1', function: { name: 'remember', arguments: '{"te' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ id: 'x1', function: { arguments: 'xt":"tea"}' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 5, function: { name: 'journal_open', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 6, function: { arguments: '{}' } }] } }] },
        finish('stop'),
      ]),
  ]);
  try {
    const { c } = client([prov(f.url)]);
    const r = await c.complete(user('q'));
    assert.equal(r.finishReason, 'tool_calls', 'tool calls win over stop');
    assert.deepEqual(
      r.toolCalls.map((t) => [t.id, t.name, t.arguments]),
      [
        ['x1', 'remember', '{"text":"tea"}'],
        ['call_1', 'journal_open', '{}'],
      ]
    );
  } finally {
    await f.close();
  }
});

test('plain JSON (non-stream) responses are accepted', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'From JSON.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'remember', arguments: { text: 'x' } } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, prompt_cache_hit_tokens: 2 },
        })
      );
    },
  ]);
  try {
    const { c } = client([prov(f.url)]);
    const seen: string[] = [];
    const r = await c.complete({ ...user('q'), onText: (t) => seen.push(t) });
    assert.equal(r.text, 'From JSON.');
    assert.deepEqual(seen, ['From JSON.']);
    assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { text: 'x' });
    assert.equal(r.usage.cachedTokens, 2);
  } finally {
    await f.close();
  }
});

test('tolerates comments, keep-alives, CRLF, event lines and garbage', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\r\n\r\n');
      res.write('event: message\r\n');
      res.write(`data: ${JSON.stringify(delta('A'))}\r\n\r\n`);
      res.write('data: {not json\r\n\r\n');
      res.write('id: 7\r\n');
      res.write('data:\r\n\r\n');
      res.write(`data:${JSON.stringify(delta('B'))}\r\n\r\n`);
      res.write(`data: ${JSON.stringify(finish())}\r\n\r\n`);
      res.end('data: [DONE]');
    },
  ]);
  try {
    const warns: string[] = [];
    const { c } = client([prov(f.url)], { log: { info() {}, warn: (m: string) => warns.push(m), error() {} } });
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'AB');
    assert.ok(warns.some((w) => /unparseable/.test(w)));
  } finally {
    await f.close();
  }
});

test('500 then 200 retries with backoff', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(500);
      res.end('boom');
    },
    (_q, res) => sse(res, [delta('ok'), finish()]),
  ]);
  try {
    const { c, sleeps } = client([prov(f.url)]);
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'ok');
    assert.equal(r.attempts, 2);
    assert.deepEqual(sleeps, [450]);
  } finally {
    await f.close();
  }
});

test('429 honours Retry-After, capped at 20s', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(429, { 'retry-after': '3' });
      res.end('slow down');
    },
    (_q, res) => {
      res.writeHead(429, { 'retry-after': '100' });
      res.end('slow down');
    },
    (_q, res) => sse(res, [delta('ok'), finish()]),
  ]);
  try {
    const { c, sleeps } = client([prov(f.url)]);
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'ok');
    assert.deepEqual(sleeps, [3000, 20000]);
  } finally {
    await f.close();
  }
});

test('idle timeout mid-stream retries', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(delta('par'))}\n\n`);
      // then stall forever
    },
    (_q, res) => sse(res, [delta('full answer'), finish()]),
  ]);
  try {
    const { c } = client([prov(f.url)], { idleTimeoutMs: 150 });
    const seen: string[] = [];
    const r = await c.complete({ ...user('q'), onText: (t) => seen.push(t) });
    assert.equal(r.text, 'full answer');
    assert.deepEqual(seen, ['par', '', 'full answer'], 'consumer told to reset before the retry');
    assert.equal(r.attempts, 2);
  } finally {
    await f.close();
  }
});

test('first-byte timeout retries', async () => {
  const f = await fakeProvider([
    () => {
      /* never respond */
    },
    (_q, res) => sse(res, [delta('ok'), finish()]),
  ]);
  try {
    const { c } = client([prov(f.url)], { firstByteTimeoutMs: 150 });
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'ok');
    assert.equal(r.attempts, 2);
  } finally {
    await f.close();
  }
});

test('connection reset retries', async () => {
  const f = await fakeProvider([
    (q) => {
      q.socket.destroy();
    },
    (_q, res) => sse(res, [delta('ok'), finish()]),
  ]);
  try {
    const { c } = client([prov(f.url)]);
    assert.equal((await c.complete(user('q'))).text, 'ok');
  } finally {
    await f.close();
  }
});

test('stream ending without [DONE] or finish is retried', async () => {
  const f = await fakeProvider([(_q, res) => sse(res, [delta('trunc')], false), (_q, res) => sse(res, [delta('whole'), finish()])]);
  try {
    const { c } = client([prov(f.url)]);
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'whole');
    assert.equal(r.attempts, 2);
  } finally {
    await f.close();
  }
});

test('finish_reason without [DONE] is accepted', async () => {
  const f = await fakeProvider([(_q, res) => sse(res, [delta('done'), finish('length')], false)]);
  try {
    const { c } = client([prov(f.url)]);
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'done');
    assert.equal(r.finishReason, 'length');
  } finally {
    await f.close();
  }
});

test('401 skips straight to the next provider', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(401);
      res.end('bad key');
    },
    (_q, res) => sse(res, [delta('from p2'), finish()]),
  ]);
  try {
    const { c, sleeps } = client([prov(f.url + '/p1'), prov(f.url + '/p2/', { name: 'p2', apiKey: 'k2', model: 'm2' })]);
    const r = await c.complete(user('q'));
    assert.equal(r.text, 'from p2');
    assert.equal(r.provider, 'p2');
    assert.equal(r.model, 'm2');
    assert.deepEqual(f.seen.map((s) => s.path), ['/p1/chat/completions', '/p2/chat/completions']);
    assert.deepEqual(sleeps, []);
  } finally {
    await f.close();
  }
});

test('all providers failing throws ModelUnavailableError without leaking keys', async () => {
  const f = await fakeProvider([
    (q, res) => {
      res.writeHead(503);
      res.end('auth was ' + q.headers.authorization);
    },
  ]);
  try {
    const { c, sleeps } = client([prov(f.url), prov(f.url, { name: 'p2', apiKey: 'other-key-XYZ' })], { maxAttemptsPerProvider: 2 });
    await assert.rejects(c.complete(user('q')), (err: unknown) => {
      assert.ok(err instanceof ModelUnavailableError);
      const all = err.message + ' ' + err.causes.join(' ');
      assert.ok(!all.includes(KEY), 'key 1 redacted');
      assert.ok(!all.includes('other-key-XYZ'), 'key 2 redacted');
      assert.equal(err.causes.length, 4);
      assert.match(err.causes[0], /HTTP 503/);
      return true;
    });
    assert.equal(f.seen.length, 4);
    assert.equal(sleeps.length, 2, 'backoff only between attempts of the same provider');
  } finally {
    await f.close();
  }
});

test('abort mid-stream rejects fast and makes no further requests', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(delta('par'))}\n\n`);
    },
  ]);
  try {
    const { c } = client([prov(f.url), prov(f.url, { name: 'p2' })]);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = c.complete({ ...user('q'), signal: ac.signal, onText: () => setTimeout(() => ac.abort(), 20) });
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
    assert.ok(Date.now() - t0 < 1000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

test('already-aborted signal rejects without a request', async () => {
  const f = await fakeProvider([(_q, res) => sse(res, [delta('x'), finish()])]);
  try {
    const { c } = client([prov(f.url)]);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(c.complete({ ...user('q'), signal: ac.signal }), (e: Error) => e.name === 'AbortError');
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});

test('abort during backoff sleep stops retrying', async () => {
  const f = await fakeProvider([
    (_q, res) => {
      res.writeHead(500);
      res.end();
    },
  ]);
  try {
    const ac = new AbortController();
    const c = createModelClient({ providers: [prov(f.url)], sleep: () => new Promise((r) => setTimeout(r, 5000).unref()), backoffBaseMs: 1 });
    const p = c.complete({ ...user('q'), signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

test('empty reply spent on reasoning retries once with thinking disabled', async () => {
  const f = await fakeProvider([
    (_q, res) => sse(res, [{ choices: [{ index: 0, delta: { reasoning_content: 'long thought' } }] }, finish('length')]),
    (_q, res) => sse(res, [delta('Short answer.'), finish()]),
  ]);
  try {
    const { c, sleeps } = client([prov(f.url, { disableThinkingParam: true })]);
    const r = await c.complete({ ...user('q'), maxTokens: 150 });
    assert.equal(r.text, 'Short answer.');
    assert.equal(f.seen[0].body.thinking, undefined);
    assert.deepEqual(f.seen[1].body.thinking, { type: 'disabled' });
    assert.equal(f.seen[1].body.max_tokens, 150);
    assert.equal(r.attempts, 2);
    assert.deepEqual(sleeps, []);
  } finally {
    await f.close();
  }
});

test('empty reply without thinking switch is retryable, then unavailable', async () => {
  const f = await fakeProvider([(_q, res) => sse(res, [finish('stop')])]);
  try {
    const { c } = client([prov(f.url)], { maxAttemptsPerProvider: 2 });
    await assert.rejects(c.complete(user('q')), (e: unknown) => e instanceof ModelUnavailableError && /empty reply/.test(e.message));
    assert.equal(f.seen.length, 2);
  } finally {
    await f.close();
  }
});

test('request body shape', async () => {
  const f = await fakeProvider([(_q, res) => sse(res, [delta('ok'), finish()])]);
  try {
    const { c } = client([prov(f.url)]);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'remind me' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'remind_set', arguments: '{"text":"x"}' }] },
      { role: 'tool', content: 'Reminder #1 set.', tool_call_id: 'c1' },
    ];
    await c.complete({ messages, maxTokens: 4096, temperature: 0.6 });
    const b = f.seen[0].body;
    assert.equal(b.model, 'm1');
    assert.equal(b.tools, undefined);
    assert.equal(b.tool_choice, undefined);
    assert.equal(b.max_tokens, 4096);
    assert.equal(b.temperature, 0.6);
    assert.deepEqual(b.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'remind me' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remind_set', arguments: '{"text":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Reminder #1 set.' },
    ]);
    await c.complete({ messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }], toolChoice: 'none' });
    const b2 = f.seen[1].body;
    assert.deepEqual(b2.tools, [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } } }]);
    assert.equal(b2.tool_choice, 'none');
    await c.complete({ messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] });
    assert.equal(f.seen[2].body.tool_choice, 'auto');
  } finally {
    await f.close();
  }
});

test('image parts pass through for vision providers and are replaced otherwise', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ];
  assert.deepEqual(serializeMessages(msgs, true)[0].content, msgs[0].content);
  assert.deepEqual(serializeMessages(msgs, false)[0].content, [
    { type: 'text', text: 'what is this' },
    { type: 'text', text: '[image omitted: this model cannot view images]' },
  ]);
});

test('no providers configured', async () => {
  const c = createModelClient({ providers: [] });
  assert.equal(c.supportsImages(), false);
  await assert.rejects(c.complete(user('q')), (e: unknown) => e instanceof ModelUnavailableError && /no model provider/.test(e.message));
});

test('providersFromEnv', () => {
  assert.deepEqual(providersFromEnv({}), []);
  const ps = providersFromEnv({ DEEPSEEK_API_KEY: ' k ', OPENROUTER_API_KEY: 'o', PERSON_MODEL_URL: 'http://x/v1', PERSON_MODEL_KEY: 'c', PERSON_MODEL_NAME: 'n' });
  assert.deepEqual(ps.map((p) => p.name), ['deepseek', 'openrouter', 'custom']);
  assert.equal(ps[0].apiKey, 'k');
  assert.equal(ps[0].model, 'deepseek-chat');
  assert.equal(ps[0].baseUrl, 'https://api.deepseek.com');
  assert.equal(ps[0].images, true);
  assert.equal(ps[0].disableThinkingParam, true);
  assert.equal(providersFromEnv({ DEEPSEEK_API_KEY: 'k', PERSON_MODEL_IMAGES: '0' })[0].images, false);
  assert.equal(providersFromEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-v4-pro' })[0].model, 'deepseek-v4-pro');
  assert.deepEqual(providersFromEnv({ PERSON_MODEL_URL: 'http://x' }), [], 'incomplete custom ignored');
  assert.deepEqual(providersFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }), [], 'unrelated keys never used');
});

test('ScriptedModel scripts text, tools, errors, functions and records calls', async () => {
  const m = new ScriptedModel([
    { text: 'one two three', streamChunks: 3 },
    { toolCalls: [{ name: 'remember', args: { text: 'tea' } }, { name: 'bad', args: '{oops', id: 'fixed' }] },
    (req, i) => ({ text: `call ${i} saw ${lastUserText(req)}` }),
    { error: new Error('down') },
  ]);
  const seen: string[] = [];
  const r1 = await m.complete({ ...user('a'), onText: (t) => seen.push(t) });
  assert.equal(r1.text, 'one two three');
  assert.equal(seen.length, 3);
  assert.equal(seen[2], 'one two three');
  const r2 = await m.complete(user('b'));
  assert.equal(r2.finishReason, 'tool_calls');
  assert.equal(r2.toolCalls[0].arguments, '{"text":"tea"}');
  assert.equal(r2.toolCalls[1].arguments, '{oops');
  assert.equal(r2.toolCalls[1].id, 'fixed');
  assert.equal((await m.complete(user('c'))).text, 'call 2 saw c');
  await assert.rejects(m.complete(user('d')), /down/);
  await assert.rejects(m.complete(user('e')), /no step for call 4/);
  assert.equal(m.calls.length, 5);
  assert.equal(m.calls[0].messages[0].content, 'a');
  const r = new ScriptedModel([{ text: 'again' }], { repeatLast: true, images: false });
  await r.complete(user('x'));
  assert.equal((await r.complete(user('y'))).text, 'again');
  assert.equal(r.supportsImages(), false);
});

test('ScriptedModel delay honours abort', async () => {
  const m = new ScriptedModel([{ text: 'late', delayMs: 5000 }]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(m.complete({ ...user('x'), signal: ac.signal }), (e: Error) => e.name === 'AbortError');
});

test('toolResultsIn and lastUserText helpers', () => {
  const req = {
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'journal_open', arguments: '{}' }] },
      { role: 'tool', content: 'Journal open.', tool_call_id: 'c1' },
      { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ] as ChatMessage[],
  };
  assert.equal(lastUserText(req), 'second');
  assert.deepEqual(toolResultsIn(req), [{ toolCallId: 'c1', name: 'journal_open', content: 'Journal open.' }]);
});
