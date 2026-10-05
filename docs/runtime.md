# i-Journal — how it runs

One Telegram DM. One model loop. The model decides what to do and what to say; tools enforce the few real rules and report the truth. Nothing routes, rewrites or answers by pattern-matching what the person wrote. This is the only mode; the original scene-based companion was removed (its data is imported, see Storage).

## A turn

```
Telegram update
  -> src/bot/person/gateway.ts   allowlist, capture, media download, per-user queue; the handler returns at once
  -> src/core/loop.ts runTurn    context -> model -> tools -> observe -> ... -> reply
  -> src/bot/person/telegramIo.ts typing keep-alive, Markdown -> Telegram HTML, chunking, plain-text fallback, retries
Sweeper (src/core/sweeper.ts, every 15s): due reminders, scheduled tasks, one "journal still open" nudge per evening
```

- **Context** (`src/core/context.ts`): a byte-stable system prompt (`src/core/prompt.ts`), then a memory card (name, facts, standing instructions, saved procedures, notebooks), a rolling summary of older conversation, the recent transcript including tool calls and results, and the current message with a short context block (local time, journal state, today's page, pending reminders, what media arrived and whether it can be seen or heard, forwarded/replied-to, OneNote status). The last two photos are re-attached as images.
- **Model** (`src/core/model.ts`): streaming OpenAI-compatible client. DeepSeek first, then OpenRouter, then a custom endpoint. Retries with backoff and Retry-After, idle/first-byte timeouts, provider fallback, and a guard that retries with reasoning off when a reasoning model returns an empty answer.
- **Loop** (`src/core/loop.ts`): up to 8 tool rounds, then a final text-only call. Bad tool JSON, unknown tools and tool crashes become results the model reads. Three one-shot corrections, never edits: an empty reply, a reply that claims a save/reminder/memory no tool did, and a note citation no search returned. If the model is unreachable or the turn times out, the reply says so honestly; with the journal open, the message is put on the page as written.
- **Compaction**: after a reply is delivered, history beyond the budget is folded into the summary by a model call. A failed summary just retries next turn.

## Tools (`src/core/tools/`)

| Tool | What it does | Rules it enforces |
|---|---|---|
| journal_open / journal_write / journal_close / journal_read / journal_search | The daily page | Writes only while a session is open, after the person accepted an offer, when their own words asked (`user_asked` must quote them), or when they tapped Approve. Never on scheduled turns. No duplicates, no future dates. A session opened before midnight keeps its day until 05:00. Closing an empty page creates nothing. |
| notes_search / notes_read / notes_save | The notes library (local, plus OneNote when connected) | Searches remember what they returned so citations can be checked. |
| remember / forget / profile_update | Lasting facts, standing instructions ("be brief"), name, timezone | Timezones validated. Standing instructions are repeated next to every message. |
| remind_set / remind_list / remind_cancel | Reminders and recurring tasks (morning brief, weekly review, research jobs) | Structured input only. A past time of day rolls to its next occurrence. Scoped per user. |
| web_search (web or news) / web_fetch | Public web (`src/core/ports/web.ts`) | Results marked untrusted. Private/loopback/metadata addresses refused on every redirect. Results cached 10 min; a rate-limited provider rests 10 min. |
| currency_rate / weather / bible_verse / wikipedia | Exact answers from free sources (`src/core/ports/data.ts`) | |
| chat_search | Everything ever said in the chat (full-text) | |
| connect_service | Starts the OneNote sign-in: a link, or a link and a code | The link/code comes from the server, never invented. "Connected" is only said after the server confirms. |
| journal_location | Where journal pages are copied in OneNote; moves it on request | Creates the notebook/section when missing. |
| report_issue | A silent one-line note for the developer when something couldn't be done or they complained | Never shown to the person; kept in the turn log. |
| skill_save / skill_read | Procedures the companion writes for itself | Max 30. |
| undo | Reverses the last change of any kind | |
| stay_silent | Scheduled/background turns only | |

**Approvals.** On a turn that took in forwarded or web content, a write the person didn't ask for in their own words is parked and shown as a button ("🔐 Save the skill …" ✅ / ✖). Approve runs exactly that call; approvals expire after 24 hours.

**Reply checks** (one re-ask each, never an edit): an empty reply; a claim to have saved/scheduled/remembered/closed something no tool did (including "from now on" without saving the instruction); a note citation no search returned; a link that no tool, message or history contains.

**Limits.** A daily token cap per person (`PERSON_DAILY_TOKEN_CAP`, default 3M) pauses honestly until tomorrow; usage shows in `/health`. Background tasks get 16 tool rounds instead of 8.

## Configuration and personal data

No person is described in code. Deployment settings come from `.env`: tokens, `TELEGRAM_OWNER_ID` / `TELEGRAM_ALLOWED_IDS`, `TIMEZONE` (the fallback for anyone who hasn't said where they are, default UTC), keys. Everything about a person (name, timezone, facts, standing instructions, procedures) is in their own memory in the store, written by tools when they say it, shown by `/memory`, cleared by `/reset`. Location-dependent tools take what the model knows: `web_search` has an optional `region` (country code) for local news, `currency_rate` needs the target currencies.

## Storage

Everything lives in SQLite (`src/core/store.ts`), in the same file as the rest of the app (`DB_PATH`, default `data/i-journal.db`), in tables prefixed `core_` keyed by the Telegram user id. Journal entries, notes and the whole conversation have full-text search. Keys sent with `/key` are stored encrypted (AES-256-GCM) and never shown to the model.

A memory tidy runs once a night (03:00–06:00 local), merging duplicate facts conservatively.

## OneNote

A per-person mirror and library (`src/onenote/`, `src/bot/person/onenote*.ts`).

- **Sign-in.** Each person connects their own Microsoft account. With an https `MICROSOFT_REDIRECT_URI` it is a one-tap link (authorization code + PKCE); otherwise a code at microsoft.com/devicelogin, which needs no public address. Azure registrations differ, so the token exchange tries the shapes Microsoft accepts (Web with secret, single-page app with Origin, public client) and remembers which one worked. Before a connection counts, the account must answer OneNote; guest sign-ins and accounts without OneNote are refused with the reason. The person is told in the chat when it is connected.
- **Staying connected.** Tokens are renewed two minutes before they expire (one renewal shared by concurrent callers). When Microsoft refuses to renew (expired, revoked, 24-hour single-page-app sign-in), the connection is marked, syncing stops, and the person gets one message saying why and how to reconnect.
- **Copies.** One page per day in the journal notebook/section (default *i-Journal / Daily Entries*, movable with `journal_location`), updated in place through the remembered page id; its text lives in a managed block, photos are appended once each. Pages the old app wrote are adopted. Notes go to their own notebook/section. Requests retry on 429/5xx (Retry-After honoured) and refresh once on 401; the sweeper backs off 1, 2, 4… 30 minutes after failures.
- **Truthfulness.** The model sees whether today's page is copied (with its link) and `journal_read` shows each day's copy state; it may say something is in OneNote only when that shows "up to date".
- **Search.** Existing OneNote pages are searchable by title, section and notebook (index refreshed every 15 minutes) and readable as text.

## Logs and improving the app

- **Turn log** (`core_turns`): every turn — kind, duration, tools (with short args and failures), self-corrections, effects, model, tokens, degraded reason, crash text, the Telegram message ids of the reply, and the person's reaction to it. Kept 120 days; wiped with the person's data on `/reset` everything.
- **Feedback**: a reaction on a reply is recorded against its turn (👍/❤️… positive, 👎… negative) and shown to the companion once on the next turn, so it can adjust.
- **Issues** (`core_issues`): what the companion reported with `report_issue` (missing capability, failing tool, complaint, idea).
- **Owner tools**: `/debug [hours]` summarises speed, failures, corrections, reactions and issues; `/export [days]` sends the log as JSON lines. Other people appear only as pseudonyms and their words are never included. Offline: `npm run insights -- 72 path/to/i-journal.db`.
- **Process logs**: JSON lines in production (one per turn with tools, model and tokens; OneNote copies; deliveries; errors with stacks), readable lines locally. Credentials and token-shaped strings are masked. On each new version the owner gets one message with the version, a live model check and OneNote state.

On the first start after the switch, everything the original companion kept in SQLite is imported once per person: journal entries (days already in OneNote are marked as copied), name, timezone, the companion's name, memory notes, life areas, enabled routines (as recurring tasks) and future reminders. A full copy of the database is written next to it first (`<DB_PATH>.before-core-<date>.bak`), and the old tables are never modified.

## Reminders

The harness delivers reminders itself, at-least-once: an occurrence is marked done only after Telegram accepted the message. A failed send retries with backoff (30s doubling, max 30 min, 8 tries); a blocked bot cancels it. A late delivery says it's late. Recurring reminders keep their wall-clock time across DST and retries. A `task` reminder runs a model turn at fire time ("every morning send me a quote") and may stay silent.

## Telegram

- Allowlist: `TELEGRAM_OWNER_ID`, `TELEGRAM_ALLOWED_IDS`, and everyone who already set up the bot before. Others get one polite line; in production an empty list refuses everyone. Groups are ignored.
- Handlers return immediately; turns run in a per-user FIFO, so a slow turn never blocks anyone else or polling.
- Typing is re-sent every 4 seconds for the whole turn.
- Replies: Markdown rendered to Telegram HTML (valid by construction, fuzz-tested), split under 4096 characters keeping code fences intact, resent as plain text if Telegram ever rejects the HTML, 429 waits honoured.
- Replies fill in live (one message edited at most every 1.2s, with a status line such as "🔎 Searching the web…" while tools run), then become the rendered final answer. `PERSON_STREAM=0` turns this off.
- Reactions acknowledge what was done: ✍ saved, 👌 reminder set, 🤝 remembered.
- Commands: `/start`, `/journal`, `/thats_it`, `/last`, `/reminders`, `/memory`, `/stop` (cancel the reply being written), `/new` (fresh chat, memory kept), `/reset` (chat / memory / everything, with a second confirm), `/key NAME value` and `/keys`, `/storage`, `/health`, `/help`; owner only: `/debug`, `/export`. `/journal` and `/thats_it` guarantee their outcome even if the model doesn't act.
- The model key can come from `.env`/Railway or from the owner's `/key DEEPSEEK_API_KEY …`; it takes effect without a restart. Without one, replies say so honestly and the owner gets the exact steps.
- Photos are seen by the model. Voice notes are transcribed when `GROQ_API_KEY` (or `OPENAI_API_KEY`) is set in `.env` or sent with `/key`; otherwise the companion says it can't hear them.
- A durable inbox records each message before processing; after a crash or redeploy, interrupted messages are replayed and an undelivered reply is re-sent. A lock file stops a second local poller.
- Updates that arrived while the bot was down are kept (set `TELEGRAM_DROP_PENDING=1` to drop them).

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Type-check, ~200 unit tests (core, tools, loop, store, time, renderer, importer, OneNote against a fake Microsoft service, logging), ~30 end-to-end tests of the real bot against a fake Telegram server |
| `npm run insights` | Turn-log summary from a database file |
| `npm run test:live` | Model client against real DeepSeek (streaming, tool loop, reading handwriting) |
| `npm run eval:live` | Scenario evaluation against the real model, 3 runs each; report in `state/live-eval-report.md` |
| `npm run person:live` | Talk to the same harness in a terminal (own store, `state/person-cli.db`) |
