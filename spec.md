# i-journal — Claude Code Build Specification
> Full spec for an AI-powered daily journal bot for Francis Kangethe.
> Read this entire document before writing a single line of code.

---

## 1. Project Overview

**i-journal** is a personal AI journaling system delivered via Telegram. It guides the user (Francis) through a structured daily reflection, saves entries to Microsoft OneNote, and is built to eventually support multiple users.

The bot has two daily sessions:
- **Morning (6:00 AM)** — prayer, Bible reading, intention for the day
- **Evening (9:00 PM)** — guided reflection across 5 life dimensions

The bot is **day-aware** — it behaves differently on each day of the week based on Francis's real weekly schedule.

---

## 2. The User — Francis

- **Name:** Francis Kangethe Nganga
- **Location:** Githunguri Town, Kiambu, Kenya
- **Timezone:** Africa/Nairobi (EAT, UTC+3)
- **Role:** Fullstack freelancer, husband, father, Christian, church ministry worker
- **Primary project:** LMS for African higher learning institutions (his life's work — daily progress matters deeply)
- **Also builds:** PolyWrapper (Nigerian prediction market), portfoliome, freelance client projects
- **Aspiration:** Create Christian and tech content, market his LMS progressively
- **Communication style:** Warm, conversational, faith-anchored

### Weekly Schedule (affects bot behavior)
| Day | Special Context |
|-----|----------------|
| Monday | Attends evening class 7–8 PM |
| Tuesday | Regular day |
| Wednesday | Fasting day (skips lunch) — spiritual discipline |
| Thursday | Teaches a class 8:45–9:45 PM |
| Friday | Regular day — weekend nudge |
| Saturday | Family rest day — should go out with family |
| Sunday | Church day — sermon, worship, spiritual reflection |

---

## 3. Architecture

### V1 (current build) — Single user
- No database needed
- Francis's Telegram ID stored in `.env`
- His Microsoft OAuth token stored in `.env` (manually obtained once)
- Conversation state held in-memory per session

### V2 (future) — Multi-user
- PostgreSQL database
- Per-user OAuth flow for Microsoft
- Subscription/access control
- All modules are designed with `UserContext` as a parameter so V2 requires no rewrites, just unlocking

### System Diagram
```
Telegram (UI)
     ↓
Telegraf Bot (Node.js)
     ↓
Claude API (day-aware prompt, conversational guide)
     ↓
OneNote via Microsoft Graph API (journal storage)
     +
node-cron (6AM + 9PM schedulers)
```

---

## 4. Tech Stack

| Layer | Tool |
|-------|------|
| Language | TypeScript (strict) |
| Runtime | Node.js 22 |
| Bot framework | `telegraf` v4 |
| AI | `@anthropic-ai/sdk` (claude-sonnet-4-20250514) |
| Storage | Microsoft Graph API → OneNote |
| Scheduler | `node-cron` |
| HTTP fetch | `isomorphic-fetch` |
| Config | `dotenv` |
| Hosting | Railway |
| Module system | CommonJS (`"type": "commonjs"` in package.json) |

### Already installed dependencies
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.80.0",
    "@microsoft/microsoft-graph-client": "^3.0.7",
    "dotenv": "^17.3.1",
    "isomorphic-fetch": "^3.0.0",
    "node-cron": "^4.2.1",
    "telegraf": "^4.16.3"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "nodemon": "^3.1.3",
    "rimraf": "^6.1.3",
    "ts-node": "^10.9.2",
    "typescript": "^6.0.2"
  }
}
```

---

## 5. Folder Structure

```
i-journal/
├── src/
│   ├── app.ts                          # Entry point
│   ├── types/
│   │   └── index.ts                    # All shared TypeScript types
│   ├── config/
│   │   └── index.ts                    # Env loader with validation
│   ├── bot/
│   │   ├── index.ts                    # Bot setup, middleware, scene registration
│   │   ├── handlers/
│   │   │   ├── message.handler.ts      # Incoming message routing
│   │   │   └── command.handler.ts      # /start, /journal, /morning, /skip, /status
│   │   └── scenes/
│   │       ├── morning.scene.ts        # Morning check-in conversation flow
│   │       └── evening.scene.ts        # Evening journal conversation flow
│   ├── ai/
│   │   ├── index.ts                    # Claude API client + sendMessage()
│   │   └── prompts/
│   │       ├── dayConfig.ts            # Day-of-week config (sections, tone, special context)
│   │       ├── morning.ts              # Morning system prompt builder
│   │       └── evening.ts             # Evening system prompt builder
│   ├── onenote/
│   │   ├── auth.ts                     # Microsoft OAuth token management
│   │   └── writer.ts                   # Create/append OneNote pages
│   ├── scheduler/
│   │   └── index.ts                    # node-cron jobs for morning + evening triggers
│   └── state/
│       └── session.store.ts            # In-memory session/conversation state store
├── .env                                # Never commit
├── .env.example
├── tsconfig.json
├── package.json
└── railway.toml
```

---

## 6. TypeScript Types (`src/types/index.ts`)

```typescript
export interface UserContext {
  telegramId: string
  name: string
  timezone: string
  microsoftAccessToken: string
  preferences: {
    morningTime: string   // "06:00"
    eveningTime: string   // "21:00"
  }
}

export interface JournalEntry {
  date: string            // "2026-03-26"
  dayOfWeek: string       // "Wednesday"
  sessionType: SessionType
  sections: JournalSection[]
  ratings: DayRatings
  closingLine?: string
}

export interface JournalSection {
  key: JournalSectionKey
  emoji: string
  title: string
  content: string
}

export type JournalSectionKey =
  | 'work'
  | 'content'
  | 'family'
  | 'ministry'
  | 'personal'
  | 'fast'
  | 'class'
  | 'teaching'
  | 'church'
  | 'morning_reflection'

export interface DayRatings {
  work?: number       // 1–5
  content?: number
  family?: number
  ministry?: number
  personal?: number
}

export type SessionType = 'morning' | 'evening'

export interface ConversationState {
  userId: string
  sessionType: SessionType
  currentSectionIndex: number
  collectedSections: JournalSection[]
  ratings: DayRatings
  conversationHistory: ConversationMessage[]
  startedAt: Date
  completed: boolean
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface DayConfig {
  day: string
  tone: string
  specialSections: JournalSectionKey[]
  specialContext: string
  eveningClosingStyle: string
}
```

---

## 7. Environment Variables (`.env`)

```bash
# Telegram
TELEGRAM_BOT_TOKEN=                    # From @BotFather
TELEGRAM_OWNER_ID=                     # Francis's Telegram chat ID (from @userinfobot)

# Anthropic
ANTHROPIC_API_KEY=                     # From console.anthropic.com

# Microsoft Graph (OneNote)
MICROSOFT_CLIENT_ID=                   # From Azure App Registration
MICROSOFT_CLIENT_SECRET=               # From Azure App Registration
MICROSOFT_TENANT_ID=                   # From Azure App Registration
MICROSOFT_REDIRECT_URI=http://localhost:3000/auth/callback
MICROSOFT_ACCESS_TOKEN=                # V1: manually obtained, stored here
MICROSOFT_REFRESH_TOKEN=               # V1: for token refresh

# App
TIMEZONE=Africa/Nairobi
NODE_ENV=development
```

---

## 8. Day Configuration (`src/ai/prompts/dayConfig.ts`)

This is the brain of the day-aware system. Export a `getDayConfig(date: Date): DayConfig` function.

| Day | Tone | Special sections | Special context |
|-----|------|-----------------|-----------------|
| Monday | Energetic, intentional | `class` | Attended evening class 7–8 PM. Ask what he learned. |
| Tuesday | Regular, balanced | none | Standard full journal |
| Wednesday | Gentle, spiritually aware | `fast` | Fasting day. Acknowledge the discipline warmly. Ask what the fast meant spiritually. |
| Thursday | Reflective, teacher-mode | `teaching` | Taught a class 8:45–9:45 PM. Ask how it went, student moments. |
| Friday | Warm, transitional | none | Weekend is coming. Nudge: is he present for family or carrying work in? |
| Saturday | Light, restful | none | Rest/family day. Did he go out? Where? Family moment. Energy check after the week. Is he prepared for Sunday? |
| Sunday | Faith-anchored, reflective | `church` | Church day. Sermon highlights, worship moments, spiritual state. Is he ready for the new week? Close with a short blessing. |

---

## 9. The Journal Prompts

### Morning Prompt (all days)
```
You are Francis's morning journal companion.
Francis is a fullstack freelancer, husband, father, and Christian based in Githunguri Town, Kiambu, Kenya.

It is [DAY], [DATE]. Good morning.

Ask Francis these three things, one at a time:
1. Did you pray this morning?
2. What did you read in the Word today — any verse or thought that stood out?
3. What is the one thing you are trusting God for today?

Keep it warm, brief, and faith-anchored. After he responds to all three, write a short morning intention paragraph and close with: "Go well, Francis. The Lord goes before you."
```

### Evening Prompt (weekday base)
```
You are Francis's personal journal guide — a trusted, warm friend checking in at end of day.

Francis is:
- Fullstack freelancer (clients mostly on WhatsApp/Telegram, not always on email/calendar)
- Building his life's work: an LMS for African higher learning institutions
- Husband, father (daughter Tavana and others), son, extended family who live away
- Christian, involved in church ministry
- Aspiring content creator (Christian + tech content)
- Based in Githunguri Town, Kiambu, Kenya

Today is [DAY], [DATE].

[DAY_SPECIFIC_CONTEXT]

Guide Francis through these sections ONE AT A TIME. Wait for his response before asking the next.
Use warm, conversational language — never clinical or checklist-like.

Sections for today:
[DYNAMIC_SECTIONS_BASED_ON_DAY]

After all sections, ask him to rate each dimension 1–5:
⚙️ Work & LMS [ ]
📢 Content [ ]
👨‍👩‍👧 Family [ ]
⛪ Ministry [ ]
🌱 Personal [ ]

Then compile everything into a clean markdown journal entry structured like this:

# [DATE] — [DAY]

## ⚙️ Work & Build
[content]

## 📢 Content & Marketing
[content]

## 👨‍👩‍👧 Family
[content]

## ⛪ Ministry
[content]

## 🌱 Personal
[content]

## ⭐ Ratings
Work & LMS: X/5 | Content: X/5 | Family: X/5 | Ministry: X/5 | Personal: X/5

---
[ONE SHORT CLOSING LINE — faith-anchored, specific to what Francis shared today]

Sunday closing: a short blessing over the week ahead instead of a single line.
```

---

## 10. Session Flow

### Evening session step-by-step:
1. Scheduler fires at 9 PM OR user sends `/journal`
2. Bot sends greeting based on day of week
3. Claude asks **Section 1** (work/LMS)
4. Francis responds in Telegram chat
5. Message handler routes response to active session
6. Claude asks **Section 2**
7. ... continues through all sections for that day ...
8. Claude asks for **ratings** (1–5 per dimension)
9. Claude compiles full markdown entry
10. Bot sends formatted entry back to Francis in Telegram
11. Bot calls OneNote writer → saves entry to dated page
12. Bot confirms: *"Saved to OneNote ✓"*
13. Session marked complete

### Skip / catch-up logic:
- If a session was missed yesterday, on next trigger ask:
  *"Hey Francis, we didn't journal yesterday ([DAY]). Want to do a quick catch-up before today's?"*
- Francis replies **yes** → run yesterday's session first, then today's
- Francis replies **no** / **skip** → proceed with today only
- Track last completed date in a simple JSON file (`state/journal.state.json`) for V1

---

## 11. Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome message + explanation of the bot |
| `/morning` | Manually trigger morning check-in |
| `/journal` | Manually trigger evening journal session |
| `/skip` | Skip today's session |
| `/status` | Show today's session status (done / pending) |
| `/last` | Show last journal entry |

---

## 12. OneNote Integration

### Notebook structure:
```
Notebook: "i-Journal"
  └── Section: "Daily Entries"
        └── Page per day: "2026-03-26 — Wednesday"
```

### How to write a page:
Use Microsoft Graph API:
```
POST https://graph.microsoft.com/v1.0/me/onenote/pages
Content-Type: application/xhtml+xml

Wrap markdown content in basic XHTML for OneNote.
```

### Token management (V1):
- Access token stored in `.env` as `MICROSOFT_ACCESS_TOKEN`
- Refresh token stored as `MICROSOFT_REFRESH_TOKEN`
- `onenote/auth.ts` handles refreshing when access token expires (1 hour expiry)
- On refresh, update in-memory token (V1 does not write back to .env)

### How to get V1 tokens:
Claude Code should include a simple one-time script:
`scripts/get-token.ts` — a local Express server on port 3000 that runs the OAuth flow once, prints tokens to console, then exits. Francis runs this once manually.

---

## 13. Scheduler (`src/scheduler/index.ts`)

```typescript
// Morning: 6:00 AM EAT (Africa/Nairobi) every day
cron.schedule('0 6 * * *', () => triggerMorningSession(), { timezone: 'Africa/Nairobi' })

// Evening: 9:00 PM EAT every day
cron.schedule('0 21 * * *', () => triggerEveningSession(), { timezone: 'Africa/Nairobi' })
```

Both trigger functions should:
1. Get Francis's UserContext from config
2. Check if session already completed today (from state store)
3. If not, send Telegram message to initiate session
4. Check if yesterday was missed → offer catch-up

---

## 14. State Store (`src/state/session.store.ts`)

In-memory store for V1. Keyed by `userId`.

```typescript
// Stores active ConversationState per user
const sessions = new Map<string, ConversationState>()

export const sessionStore = {
  get: (userId: string) => sessions.get(userId),
  set: (userId: string, state: ConversationState) => sessions.set(userId, state),
  clear: (userId: string) => sessions.delete(userId),
  has: (userId: string) => sessions.has(userId),
}
```

Also maintain a simple `state/journal.state.json`:
```json
{
  "lastMorningDate": "2026-03-26",
  "lastEveningDate": "2026-03-26"
}
```

---

## 15. package.json Scripts

```json
"scripts": {
  "dev": "nodemon --exec ts-node src/app.ts",
  "build": "rimraf dist && tsc",
  "start": "node dist/app.js",
  "get-token": "ts-node scripts/get-token.ts"
}
```

---

## 16. railway.toml

```toml
[build]
builder = "nixpacks"
buildCommand = "npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "on_failure"
```

---

## 17. Build Order for Claude Code

Build in this exact order to avoid dependency issues:

1. `tsconfig.json`
2. `src/types/index.ts`
3. `src/config/index.ts`
4. `.env.example`
5. `src/state/session.store.ts`
6. `src/ai/prompts/dayConfig.ts`
7. `src/ai/prompts/morning.ts`
8. `src/ai/prompts/evening.ts`
9. `src/ai/index.ts`
10. `src/onenote/auth.ts`
11. `src/onenote/writer.ts`
12. `src/bot/handlers/command.handler.ts`
13. `src/bot/handlers/message.handler.ts`
14. `src/bot/scenes/morning.scene.ts`
15. `src/bot/scenes/evening.scene.ts`
16. `src/bot/index.ts`
17. `src/scheduler/index.ts`
18. `src/app.ts`
19. `scripts/get-token.ts`
20. `railway.toml`
21. Update `package.json` scripts

---

## 18. Key Constraints & Notes

- **Never commit `.env`** — always use `.env.example`
- **V1 is single-user** — `TELEGRAM_OWNER_ID` gates all interactions. Reject any message not from this ID.
- **Conversation history** must be passed to Claude on every turn — Claude has no memory between API calls
- **OneNote XHTML** — Graph API requires XHTML not raw markdown. Convert markdown to XHTML in `writer.ts`
- **Token refresh** — Microsoft access tokens expire in 1 hour. Always check and refresh before writing to OneNote
- **Timezone** — all cron jobs and date formatting must use `Africa/Nairobi`
- **Model** — always use `claude-sonnet-4-20250514`
- **Max tokens** — set to `1024` for journal responses
- **Session isolation** — a morning session and an evening session are separate. Don't mix their state.
- **Graceful handling** — if Claude API or OneNote fails, tell Francis in Telegram and log the error. Never crash silently.

---

## 19. Future V2 Notes (do not build now, just keep in mind)

- PostgreSQL for user storage
- Per-user Microsoft OAuth flow
- Weekly summary report (every Sunday, Claude summarizes the week's ratings and patterns)
- Dashboard (Next.js) showing rating trends over time
- Packageable as a SaaS product for Christian professionals
- WhatsApp support via Twilio as alternative to Telegram

---

*End of specification. Build confidently, Francis.*