import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { AlbumCollector, downloadMedia, mergeInbounds, TgMessage, toInbound } from '../../src/bot/person/inbound';
import { DeliveryError, deliverMarkdown, keepTyping, TelegramApi } from '../../src/bot/person/telegramIo';
import { allowListFromEnv } from '../../src/bot/person/gateway';
import { Inbound, InboundMedia } from '../../src/core/types';

test('toInbound maps text, captions, media, replies, quotes and forwards', () => {
  assert.equal(toInbound({ message_id: 1 }), null);
  assert.deepEqual(toInbound({ message_id: 1, text: 'hi' }), { kind: 'message', messageId: 1, text: 'hi', media: [], target: undefined, forwarded: undefined });
  const photo = toInbound({ message_id: 2, caption: 'sunset', photo: [{ file_id: 'small' }, { file_id: 'big', file_size: 10 }] })!;
  assert.equal(photo.text, 'sunset');
  assert.deepEqual(photo.media, [{ kind: 'photo', fileId: 'big', mime: 'image/jpeg' }]);
  const voice = toInbound({ message_id: 3, voice: { file_id: 'v', duration: 7, mime_type: 'audio/ogg' } })!;
  assert.deepEqual(voice.media, [{ kind: 'voice', fileId: 'v', mime: 'audio/ogg', duration: 7 }]);
  const sticker = toInbound({ message_id: 4, sticker: { file_id: 's', emoji: '😂' } })!;
  assert.deepEqual(sticker.media, [{ kind: 'sticker', fileId: 's', emoji: '😂' }]);
  const reply = toInbound(
    { message_id: 5, text: 'keep this', quote: { text: 'the part' }, reply_to_message: { message_id: 4, from: { id: 99, is_bot: true }, text: 'my earlier answer' } },
    99
  )!;
  assert.deepEqual(reply.target, { messageId: 4, text: 'my earlier answer', quote: 'the part', media: [], fromBot: true });
  const theirs = toInbound({ message_id: 6, text: 'this', reply_to_message: { message_id: 3, from: { id: 1 }, photo: [{ file_id: 'p' }] } }, 99)!;
  assert.equal(theirs.target?.fromBot, false);
  assert.equal(theirs.target?.media[0].kind, 'photo');
  assert.equal(toInbound({ message_id: 7, text: 'fwd', forward_origin: { type: 'user' } })!.forwarded, true);
  assert.equal(toInbound({ message_id: 8, text: 'fwd', forward_date: 1 })!.forwarded, true);
  const doc = toInbound({ message_id: 9, document: { file_id: 'd', mime_type: 'application/pdf', file_name: 'cv.pdf' } })!;
  assert.deepEqual(doc.media, [{ kind: 'document', fileId: 'd', mime: 'application/pdf', fileName: 'cv.pdf' }]);
});

test('mergeInbounds and AlbumCollector deliver one ordered inbound per album without waiting on anything', async () => {
  const parts: Inbound[] = [
    { kind: 'message', messageId: 12, media: [{ kind: 'photo', fileId: 'b' }] },
    { kind: 'message', messageId: 11, text: 'two shots', media: [{ kind: 'photo', fileId: 'a' }] },
  ];
  const merged = mergeInbounds(parts);
  assert.equal(merged.text, 'two shots');
  assert.equal(merged.media.length, 2);
  const ready: Array<[string, Inbound]> = [];
  const albums = new AlbumCollector((k, m) => ready.push([k, m]), 30);
  albums.add('u:g1', parts[0]);
  albums.add('u:g1', parts[1]);
  albums.add('u:g2', { kind: 'message', messageId: 20, media: [{ kind: 'photo', fileId: 'c' }] });
  assert.equal(albums.size, 2);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ready.length, 2);
  const g1 = ready.find(([k]) => k === 'u:g1')![1];
  assert.deepEqual(g1.media.map((m) => m.fileId), ['a', 'b'], 'ordered by message id');
  assert.equal(g1.messageId, 11);
  albums.add('u:g3', parts[0]);
  albums.flushAll();
  assert.equal(ready.length, 3);
  assert.equal(albums.size, 0);
});

test('downloadMedia saves wanted kinds, enforces the size cap, never throws', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200);
      res.end(Buffer.alloc(2048));
      return;
    }
    if (req.url === '/fail') {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(Buffer.from('JPEGDATA'));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  try {
    const api = {
      getFile: async (id: string) => ({ file_path: id === 'v' ? 'voice/file.oga' : `photos/${id}.jpg`, file_size: id === 'huge' ? 999_999_999 : 10 }),
      getFileLink: async (id: string) => new URL(id === 'big' ? `${base}/big` : id === 'bad' ? `${base}/fail` : `${base}/ok`),
    };
    const media: InboundMedia[] = [
      { kind: 'photo' as const, fileId: 'p1' },
      { kind: 'voice' as const, fileId: 'v' },
      { kind: 'sticker' as const, fileId: 's' },
      { kind: 'video' as const, fileId: 'vid' },
      { kind: 'photo' as const, fileId: 'huge' },
      { kind: 'photo' as const, fileId: 'big' },
      { kind: 'photo' as const, fileId: 'bad' },
    ];
    const warns: string[] = [];
    await downloadMedia(api, media, dir, '42', { maxBytes: 1024, log: { info() {}, warn: (m) => warns.push(m), error() {} } });
    assert.ok(media[0].localPath && fs.readFileSync(media[0].localPath, 'utf8') === 'JPEGDATA');
    assert.match(media[1].localPath || '', /42-1-voice\.ogg$/, '.oga saved as .ogg for transcription APIs');
    assert.equal(media[2].localPath, undefined, 'stickers skipped');
    assert.equal(media[3].localPath, undefined, 'videos skipped');
    assert.equal(media[4].localPath, undefined, 'over the reported size cap');
    assert.equal(media[5].localPath, undefined, 'over the streamed size cap');
    assert.equal(media[6].localPath, undefined, 'server error');
    assert.ok(warns.length >= 3);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeApi(script: Array<(text: string, extra: Record<string, unknown>) => unknown>) {
  const calls: Array<{ text: string; extra: Record<string, unknown> }> = [];
  let i = 0;
  const api: TelegramApi = {
    sendMessage: async (_chat, text, extra = {}) => {
      calls.push({ text, extra: { ...extra } });
      const step = script[Math.min(i++, script.length - 1)];
      const out = step(text, extra);
      if (out instanceof Error) throw out;
      return { message_id: 100 + i };
    },
    sendChatAction: async () => true,
  };
  return { api, calls };
}

const tgErr = (code: number, description: string, retry_after?: number) =>
  Object.assign(new Error(`${code}: ${description}`), { response: { error_code: code, description, parameters: retry_after ? { retry_after } : undefined } });

test('deliverMarkdown sends rendered HTML, splits long replies, and falls back to plain text on parse errors', async () => {
  const ok = fakeApi([() => true]);
  const ids = await deliverMarkdown(ok.api, 1, '**hi** there');
  assert.deepEqual(ids, [101]);
  assert.equal(ok.calls[0].text, '<b>hi</b> there');
  assert.equal(ok.calls[0].extra.parse_mode, 'HTML');
  assert.deepEqual(ok.calls[0].extra.link_preview_options, { is_disabled: true });

  const long = fakeApi([() => true]);
  await deliverMarkdown(long.api, 1, Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ` + 'w '.repeat(200)).join('\n\n'));
  assert.ok(long.calls.length >= 3);
  for (const c of long.calls) assert.ok(c.text.length <= 4096);

  const parse = fakeApi([() => tgErr(400, "Bad Request: can't parse entities: unsupported start tag"), () => true]);
  await deliverMarkdown(parse.api, 1, '**hi**');
  assert.equal(parse.calls.length, 2);
  assert.equal(parse.calls[1].text, 'hi');
  assert.equal(parse.calls[1].extra.parse_mode, undefined);
});

test('deliverMarkdown waits out flood control, retries transient errors, stops on permanent ones', async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const flood = fakeApi([() => tgErr(429, 'Too Many Requests: retry after 3', 3), () => true]);
  await deliverMarkdown(flood.api, 1, 'x', { sleep });
  assert.deepEqual(sleeps, [3000]);
  const transient = fakeApi([() => tgErr(502, 'Bad Gateway'), () => new Error('socket hang up'), () => true]);
  await deliverMarkdown(transient.api, 1, 'x', { sleep });
  assert.equal(transient.calls.length, 3);
  const blocked = fakeApi([() => tgErr(403, 'Forbidden: bot was blocked by the user')]);
  await assert.rejects(deliverMarkdown(blocked.api, 1, 'x', { sleep }), (e: unknown) => e instanceof DeliveryError && e.permanent);
  assert.equal(blocked.calls.length, 1);
  const down = fakeApi([() => tgErr(500, 'Internal')]);
  await assert.rejects(deliverMarkdown(down.api, 1, 'x', { sleep }), (e: unknown) => e instanceof DeliveryError && !e.permanent);
  assert.equal(down.calls.length, 4);
  const gone = fakeApi([() => tgErr(400, 'Bad Request: message to be replied not found'), () => true]);
  await deliverMarkdown(gone.api, 1, 'x', { replyTo: 55, sleep });
  assert.ok(gone.calls[0].extra.reply_parameters);
  assert.equal(gone.calls[1].extra.reply_parameters, undefined);
});

test('keepTyping re-sends until stopped and survives errors', async () => {
  let n = 0;
  const api: TelegramApi = {
    sendMessage: async () => ({ message_id: 1 }),
    sendChatAction: async () => {
      n++;
      if (n === 2) throw new Error('network');
      return true;
    },
  };
  const stop = keepTyping(api, 1, 15);
  await new Promise((r) => setTimeout(r, 70));
  stop();
  const seen = n;
  assert.ok(seen >= 3, `sent ${seen}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, seen, 'stopped');
});

test('allowlist from env', () => {
  const a = allowListFromEnv({ TELEGRAM_OWNER_ID: '111', TELEGRAM_ALLOWED_IDS: '222, 333 bad' });
  assert.equal(a.isAllowed(111), true);
  assert.equal(a.isAllowed('222'), true);
  assert.equal(a.isAllowed(333), true);
  assert.equal(a.isAllowed(444), false);
  assert.equal(allowListFromEnv({ NODE_ENV: 'production' }).isAllowed(1), false, 'fail closed in production');
  assert.equal(allowListFromEnv({ NODE_ENV: 'development' }).isAllowed(1), true, 'open in dev when unset');
});
