# i-journal

A journaling companion in a Telegram DM. One model loop decides what to do and what to say; tools do the work and report the truth. It keeps a daily page, a notes library (mirrored to OneNote when connected), reminders and routines, and a memory of the person it talks to.

How it runs, tool by tool, is in [docs/runtime.md](docs/runtime.md). What is verified and what is left is in [docs/live-readiness.md](docs/live-readiness.md).

## Where things live

Nothing about any particular person is written in the code. Like Claude Code (code, then settings, then memory), there are three layers:

| Layer | What goes there | How it changes |
|---|---|---|
| Code (`src/core`) | Neutral defaults and the rules tools enforce | A code change |
| `.env` / Railway variables | Deployment settings: bot tokens, owner and allowed Telegram ids, the fallback `TIMEZONE`, model and service keys | Edit and restart (or `/key` for keys) |
| Per-person memory (SQLite) | Name, timezone, lasting facts, standing instructions ("keep it short"), saved procedures, journal, notes, reminders | Just say it in the chat. See it with `/memory`, clear it with `/reset`, add a private key with `/key NAME value` (stored encrypted, never shown to the model) |

Anything that depends on where someone is (local news, currency, weather) comes from what the companion knows about them, or it asks once.

## Run it locally

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `TELEGRAM_BOT_TOKEN_TEST` (a second bot for testing), `TELEGRAM_OWNER_ID` and `DEEPSEEK_API_KEY`, then:

```bash
npm run build
```

```bash
node dist/app.js
```

Run one poller per bot token at a time. To talk to the same harness in a terminal:

```bash
npm run person:live
```

## Tests

```bash
npm test
```

`npm run test:live` and `npm run eval:live` run against the real model (they need `DEEPSEEK_API_KEY`). `npm run insights -- 24 data/i-journal.db` summarises the turn log of a database.

## Deploy (Railway)

Railway builds every push to `main` (`railway.toml`: `npm run build`, then `npm start`).

- Mount a volume and set `DB_PATH=/data/i-journal.db`; photos are kept next to it.
- Set `NODE_ENV=production`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `DEEPSEEK_API_KEY` (or send `/key DEEPSEEK_API_KEY …` to the bot as the owner), and `TIMEZONE`.
- With a public domain (Railway → Settings → Networking) updates arrive by webhook and OneNote can use the one-tap link (`MICROSOFT_REDIRECT_URI=https://<domain>/auth/callback`, registered in Azure under "Web"). Without one, the bot polls and OneNote uses a sign-in code.
- On the first start the original companion's data is imported once, after a full backup of the database file.

## Project structure

```
src/
├── app.ts            # Entry: database, bot, OneNote, web server, launch
├── config/           # Deployment settings from the environment
├── core/             # The harness: loop, context, prompt, tools, store, sweeper, model client, logs
├── bot/person/       # Telegram gateway, delivery, inbox, OneNote library and sign-in service
├── onenote/          # Microsoft sign-in (PKCE, device code), Graph client, XHTML
├── web/              # Webhook, Microsoft callback, /health
├── db/               # SQLite connection, app tables (users, connections, old companion tables)
└── cli/              # Terminal chat, turn-log insights
tests/                # Unit, end-to-end (fake Telegram, fake Microsoft) and live model tests
```
