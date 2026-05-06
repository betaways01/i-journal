# i-journal

An AI-powered daily journaling bot on Telegram. It guides you through structured morning and evening reflection sessions using Claude, saves entries to a local SQLite database, and optionally syncs to Microsoft OneNote.

## How It Works

- **Morning session** — Brief spiritual check-in: prayer, Bible reading, one thing you're trusting God for today.
- **Evening session** — Guided reflection across the life areas you pick during setup.
- **Day-aware prompts** — Tone and extra sections adapt to the day of the week (fasting, classes, church, etc.) based on each user's own weekly schedule.
- **Local-first storage** — Every compiled entry is saved to SQLite first. OneNote sync is best-effort; a failed sync never loses your journal.
- **Multi-user** — Anyone can `/start` the bot and set up their own profile, schedule, and sections. Each user has their own independent journal state.
- **Routine engine** — Lightweight DB-backed routines can run helpful recurring actions, starting with a daily conversation word.
- **Agent workspace** — Each user gets OpenClaw-style workspace docs in SQLite (`SOUL.md`, `USER.md`, `IDENTITY.md`, etc.) so setup and future sessions can stay adaptive without becoming arbitrary.
- **Inline button prompts** — Scheduled check-ins arrive with Start / Remind later / Catch up / Skip buttons.

### Commands

| Command    | Description                                |
|------------|--------------------------------------------|
| `/start`   | Onboard a new user or show the main menu   |
| `/morning` | Manually start a morning check-in          |
| `/journal` | Manually start an evening journal          |
| `/catchup` | Journal yesterday's entry under yesterday's date |
| `/settings`| Update sections, schedule, or check-in times |
| `/skip`    | Skip the current session                   |
| `/status`  | Show today's completion status             |
| `/last`    | Show your last journal entry               |
| `/storage` | Show cloud sync status                     |
| `/health`  | Show bot / DB status                       |

## Tech Stack

- **Runtime:** Node.js 22, TypeScript
- **Bot:** Telegraf
- **AI:** Anthropic Claude (Sonnet)
- **Database:** SQLite via `better-sqlite3` (persistent journaling, sessions, profiles)
- **Cloud sync (optional):** Microsoft OneNote via Graph API
- **Scheduling:** `node-cron` for the heartbeat, SQLite for durable routine state
- **Hosting:** Railway (with a mounted volume for the SQLite file)

## Setup

### Prerequisites

- Node.js 22+
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Anthropic API key

Optional (needed for OneNote sync):
- Microsoft Azure app registration

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Only `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY` are strictly required. Everything else is optional.

### Microsoft OneNote OAuth (optional)

For users with personal Microsoft accounts, your Azure app registration must support them:

- Azure Portal -> App registrations -> your app -> Authentication
- Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
- Set `MICROSOFT_TENANT_ID=common` in your environment

### Get Legacy Owner Microsoft Tokens (optional)

If you want OneNote sync for your own (owner) account:

```bash
npm run get-token
```

This starts a local server on port 3000, opens the Microsoft login flow, and prints the tokens to your terminal. Copy them into `.env` as `MICROSOFT_ACCESS_TOKEN` and `MICROSOFT_REFRESH_TOKEN`.

### Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build && npm start
```

On first boot, if a legacy `state/profile.json` or `state/journal.state.json` exists (from the single-user build) and `TELEGRAM_OWNER_ID` is set, it will be auto-imported into SQLite as the owner's data.

## Project Structure

```
src/
├── app.ts                   # Entry: init DB, bot, scheduler
├── config/                  # Env loader
├── db/
│   ├── index.ts             # SQLite connection + migrations
│   ├── users.repo.ts        # User CRUD
│   ├── profile.repo.ts      # Per-user profile storage
│   ├── journalState.repo.ts # Per-user completion tracking
│   ├── sessions.repo.ts     # Persistent active sessions
│   ├── entries.repo.ts      # Compiled journal entries (local source of truth)
│   ├── routines.repo.ts     # DB-backed recurring routines + run history
│   ├── agentWorkspace.repo.ts # OpenClaw-style workspace docs in SQLite
│   └── legacy.migrate.ts    # One-time JSON → SQLite import
├── agent/                   # Workspace docs + LLM bootstrap understanding
├── profile/
│   └── defaults.ts          # Profile type, default template, normalization
├── bot/
│   ├── index.ts             # Bot wiring
│   ├── userContext.ts       # Resolve BotUser (row + profile) from Telegram ctx
│   ├── handlers/            # /commands, text routing, inline-button callbacks
│   └── scenes/              # onboarding, morning, evening, settings flows
├── ai/
│   └── prompts/             # Day-aware prompt builders (pure — take Profile as arg)
├── onenote/                 # Microsoft Graph client (owner-only for now)
├── routines/                # Routine schedules and executable skills
├── scheduler/               # node-cron jobs plus the routine heartbeat
└── state/                   # Thin session-store facade over SQLite
scripts/
└── get-token.ts             # One-time OAuth helper for owner's Microsoft tokens
data/
└── i-journal.db             # Created on first boot (configurable via DB_PATH)
```

## Deployment on Railway

Railway has a "Volumes" feature — create a volume and mount it (e.g. at `/data`), then set `DB_PATH=/data/i-journal.db`. This ensures the SQLite file survives deploys and restarts.

```toml
# railway.toml
[build]
builder = "nixpacks"
buildCommand = "npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "on_failure"
```

## Roadmap

- Per-user Microsoft OAuth (web callback server + encrypted refresh tokens)
- Additional storage backends: Google Drive, Notion, Markdown export, email-to-self
- Weekly / monthly AI review ("what did I say about work last week?")
- Voice-note journaling
- Short-journal mode for tired days
