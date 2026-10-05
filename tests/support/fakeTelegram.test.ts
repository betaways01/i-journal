import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegraf, TelegramError } from 'telegraf';
import { FakeTelegram } from './fakeTelegram';

const U = 4242;

async function launched(fake: FakeTelegram, setup: (bot: Telegraf) => void): Promise<Telegraf> {
  const bot = new Telegraf(fake.token, { telegram: { apiRoot: fake.apiRoot } });
  setup(bot);
  await new Promise<void>((resolve) => {
    void bot.launch({}, resolve).catch(() => undefined);
  });
  return bot;
}

test('fake Telegram behaves like the Bot API for a real telegraf bot', async () => {
  const fake = await FakeTelegram.start();
  const bot = await launched(fake, (b) => {
    b.command('ping', (ctx) => ctx.reply('pong'));
    b.on('callback_query', (ctx) => ctx.answerCbQuery('ok'));
    b.on('text', (ctx) => ctx.reply('echo: ' + ctx.message.text));
    b.on('photo', async (ctx) => {
      const link = await ctx.telegram.getFileLink(ctx.message.photo.at(-1)!.file_id);
      const bytes = Buffer.from(await (await fetch(link.toString())).arrayBuffer());
      await ctx.reply(`photo ${bytes.length} bytes, caption ${ctx.message.caption}`);
    });
  });
  try {
    fake.sendText(U, 'hello');
    await fake.waitForBotMessages(U, 1);
    assert.equal(fake.lastBotText(U), 'echo: hello');

    fake.sendCommand(U, '/ping');
    await fake.waitForBotMessages(U, 2);
    assert.equal(fake.lastBotText(U), 'pong');

    fake.sendPhoto(U, { caption: 'sunset', bytes: Buffer.from('12345') });
    await fake.waitForBotMessages(U, 3);
    assert.equal(fake.lastBotText(U), 'photo 5 bytes, caption sunset');

    const botMsg = fake.botMessages(U)[0];
    fake.pressButton(U, botMsg.message_id, 'x');
    await fake.waitFor(() => fake.callsTo('answerCallbackQuery').length === 1);

    const album = fake.sendAlbum(U, [{ caption: 'a' }, {}, {}]);
    assert.equal(new Set(album.map((m) => m.media_group_id)).size, 1);
    await fake.waitForBotMessages(U, 6);
  } finally {
    bot.stop('test');
    await fake.stop();
  }
});

test('fake Telegram enforces real constraints', async () => {
  const fake = await FakeTelegram.start();
  const bot = new Telegraf(fake.token, { telegram: { apiRoot: fake.apiRoot } });
  const tg = bot.telegram;
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 0;
    } catch (e) {
      assert.ok(e instanceof TelegramError);
      return e.code;
    }
  };
  try {
    assert.equal(await code(tg.sendMessage(U, 'hi')), 400, 'unknown chat');
    fake.sendText(U, 'register me');
    assert.equal(await code(tg.sendMessage(U, '')), 400);
    assert.equal(await code(tg.sendMessage(U, 'x'.repeat(4097))), 400);
    assert.equal(await code(tg.sendMessage(U, 'x'.repeat(4096))), 0);
    assert.equal(await code(tg.sendMessage(U, '<b>bold', { parse_mode: 'HTML' })), 400);
    assert.equal(await code(tg.sendMessage(U, '<b>' + 'x'.repeat(4096) + '</b>', { parse_mode: 'HTML' })), 0, 'limit counts visible text');
    assert.equal(await code(tg.sendMessage(U, 'a.b', { parse_mode: 'MarkdownV2' })), 400);
    const sent = await tg.sendMessage(U, 'original');
    assert.equal(await code(tg.editMessageText(U, sent.message_id, undefined, 'original')), 400, 'not modified');
    assert.equal(await code(tg.editMessageText(U, sent.message_id, undefined, 'changed')), 0);
    assert.deepEqual(fake.botMessages(U).at(-1)?.edits, ['original']);
    assert.equal(await code(tg.editMessageText(U, 999999, undefined, 'x')), 400);
    fake.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } });
    try {
      await tg.sendMessage(U, 'x');
      assert.fail('expected 429');
    } catch (e) {
      assert.equal((e as TelegramError).code, 429);
      assert.equal((e as TelegramError).parameters?.retry_after, 2);
    }
    fake.block(U);
    assert.equal(await code(tg.sendMessage(U, 'x')), 403);
    fake.block(U, false);
    const wrong = new Telegraf('999:WRONG', { telegram: { apiRoot: fake.apiRoot } });
    assert.equal(await code(wrong.telegram.getMe()), 401);
  } finally {
    await fake.stop();
  }
});

test('a second poller gets 409, and long polls wake on new updates', async () => {
  const fake = await FakeTelegram.start();
  try {
    const call = (offset = 0) =>
      fetch(`${fake.apiRoot}/bot${fake.token}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 5, offset }) }).then(
        (r) => r.json() as Promise<{ ok: boolean; error_code?: number; result?: Array<{ update_id: number }> }>
      );
    const first = call();
    await new Promise((r) => setTimeout(r, 50));
    const second = call();
    const r1 = await first;
    assert.equal(r1.ok, false);
    assert.equal(r1.error_code, 409);
    const t0 = Date.now();
    setTimeout(() => fake.sendText(U, 'wake'), 100);
    const r2 = await second;
    assert.ok(r2.ok);
    assert.equal(r2.result?.length, 1);
    assert.ok(Date.now() - t0 < 2000);
    const id = r2.result![0].update_id;
    const r3 = await fetch(`${fake.apiRoot}/bot${fake.token}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offset: id + 1 }) }).then((r) => r.json() as Promise<{ result: unknown[] }>);
    assert.deepEqual(r3.result, [], 'offset confirms delivered updates');
  } finally {
    await fake.stop();
  }
});
