# 0001 - Persist SQLite on Railway Volumes

Date: 2026-05-07

Status: Accepted

## Context

i-Journal stores users, profiles, sessions, journal entries, reminders, routines, and agent workspace documents in SQLite.

The app previously defaulted to `data/i-journal.db` when `DB_PATH` was not set. That works locally, but in Railway production it can put the database on ephemeral container storage. Redeploys, fixes, or infrastructure restarts could then lose active sessions and user data.

## Decision

Production must use a Railway volume mounted at `/data`, with:

```text
DB_PATH=/data/i-journal.db
```

The app now refuses to boot in production if `DB_PATH` is missing. Local development may continue to use the default `data/i-journal.db`.

## Consequences

- User sessions, routines, reminders, entries, and profiles survive pushes and redeploys.
- A missing production `DB_PATH` fails loudly instead of silently using unsafe storage.
- Railway volume configuration is part of the production architecture, not an optional deploy detail.

## Operational Notes

- Railway project: `i-journal`
- Railway environment: `production`
- Railway service: `i-journal`
- Railway volume: `i-journal-volume`
- Mount path: `/data`
