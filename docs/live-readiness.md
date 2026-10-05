# Live readiness

## Run it locally (test bot)

```bash
npm run build
```

```bash
node dist/app.js
```

Locally the app uses `TELEGRAM_BOT_TOKEN_TEST`. Run one process at a time — a second poller on the same token kills both (a lock file stops a second local one). To talk in a terminal instead:

```bash
npm run person:live
```

## Verified (2026-10-05)

- Offline: `npm test` — type-check, 202 unit tests and 30 end-to-end tests against a fake Telegram Bot API (real telegraf polling). New since the last round: the one-time import of the original companion's data, OneNote sign-in and sync against a fake Microsoft service (Web and single-page-app registrations, PKCE, device codes, expired renewals, guest and unlicensed accounts, throttling, in-place page updates, photos, adopting old pages), the turn log, reactions as feedback, `/debug`, `/export`, the no-model-key path, and log redaction.
- Live model: `npm run test:live` 4/4 (including reading a handwritten page); `npm run eval:live` 135/135 over 3 runs of each scenario, and the web + soak scenarios 80/80 over 5 runs after tightening the "check anything that may have changed" rule.
- Live Microsoft endpoints: the one-tap link (PKCE) reaches Microsoft's sign-in page for personal and work accounts; code sign-in starts for work/school accounts.
- The real app on the test bot: imports the old tables once (backup file first), checks the model, registers the menu (owner extras included), finds a dead OneNote sign-in at startup, marks it and tells the owner once.

## Needs the owner

- **Model key in production.** Add `DEEPSEEK_API_KEY` in Railway → Variables, or send `/key DEEPSEEK_API_KEY …` to the bot as the owner. Until then the bot says it isn't switched on (and tells the owner how).
- **OneNote for a personal Microsoft account**, one of:
  - Azure → App registrations → the app → Authentication → *Allow public client flows* = **Yes** (code sign-in then works anywhere, no public address needed); or
  - give the Railway service a public domain and set `MICROSOFT_REDIRECT_URI=https://<domain>/auth/callback`, registered in Azure under **Web** (not "Single-page application", which Microsoft limits to 24 hours).
- `MICROSOFT_TENANT_ID` should be `common` (a single tenant id makes personal accounts guests, and OneNote fails for them). The local `.env` currently sets a tenant id.
- Voice notes need a key: `/key GROQ_API_KEY …` in Telegram or `GROQ_API_KEY` in Railway.

## Not built yet

- Voice replies, Outlook Calendar / Microsoft To Do, a journal mini-app.
- A general API caller and a code sandbox (refused by the permission system as a code-execution surface; they need the owner's explicit approval).
