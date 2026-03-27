# i-journal

An AI-powered daily journaling bot on Telegram. It guides you through structured morning and evening reflection sessions using Claude, then saves each entry to Microsoft OneNote.

## How It Works

- **Morning session (6:00 AM)** — Brief spiritual check-in: prayer, Bible reading, one thing you're trusting God for today.
- **Evening session (9:00 PM)** — Guided reflection across 5 life dimensions (Work, Content & Marketing, Family, Ministry, Personal) with 1-5 ratings per area.
- **Day-aware prompts** — Tone and extra sections adapt to the day of the week (e.g., fasting on Wednesday, teaching on Thursday, church on Sunday).
- **OneNote storage** — Completed entries are converted to XHTML and saved as dated pages under `i-Journal > Daily Entries`.

### Commands

| Command    | Description                          |
|------------|--------------------------------------|
| `/start`   | Welcome and feature overview         |
| `/morning` | Manually trigger morning check-in    |
| `/journal` | Manually trigger evening journal     |
| `/skip`    | Skip current session                 |
| `/status`  | Show today's session completion      |
| `/last`    | Link to OneNote notebook             |

## Tech Stack

- **Runtime:** Node.js 22, TypeScript
- **Bot:** Telegraf
- **AI:** Anthropic Claude (Sonnet)
- **Storage:** Microsoft OneNote via Graph API
- **Scheduling:** node-cron
- **Hosting:** Railway

## Setup

### Prerequisites

- Node.js 22+
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Anthropic API key
- Microsoft Azure app registration (for OneNote OAuth)

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

### Get Microsoft Tokens

Run the OAuth helper to obtain access and refresh tokens:

```bash
npm run get-token
```

This starts a local server on port 3000, opens the Microsoft login flow, and prints the tokens to your terminal. Copy them into `.env`.

### Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build && npm start
```

## Project Structure

```
src/
├── app.ts                  # Entry point
├── config/                 # Env validation & config
├── bot/
│   ├── handlers/           # Command & message routing
│   └── scenes/             # Morning & evening session flows
├── ai/
│   └── prompts/            # Day-aware system prompts
├── onenote/
│   ├── auth.ts             # Microsoft token management
│   └── writer.ts           # Markdown -> XHTML -> OneNote
├── scheduler/              # Cron jobs (6 AM / 9 PM)
└── state/                  # In-memory session store
scripts/
└── get-token.ts            # One-time OAuth token helper
```

## Deployment

Deployed on Railway. Push to git and it builds automatically:

```toml
# railway.toml
[build]
builder = "nixpacks"
buildCommand = "npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "on_failure"
```
