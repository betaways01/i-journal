# 0003 - Session Lifecycle

Date: 2026-05-07

Status: Accepted

## Context

Sessions are persisted in SQLite so users can continue after app restarts, pushes, or redeploys. However, many handlers check for an active session and block new flows if one exists.

A short global stale-session timeout made deploy persistence feel unreliable. A session could survive storage but still be deleted after a few hours. On the other hand, abandoned sessions should not block a user forever.

## Decision

Session cleanup is type-aware:

- `morning`, `evening`, `drop`, `vent`: 24 hours
- `settings`, `automation_setup`, `routine_setup`: 72 hours
- `onboarding`: 168 hours

Stale sessions are cleared at the session repository boundary when reading or checking for active sessions. Scheduler cleanup uses the same type-aware logic.

## Consequences

- Sessions survive normal deploy/fix cycles.
- Old abandoned journal sessions stop blocking new work.
- Setup and automation flows get more time because users may pause while deciding.
- The app no longer uses a blunt global 3-hour cleanup rule.

## Guardrails

- Do not reintroduce same-day-only cleanup for persisted sessions.
- Any new session type must have an intentional TTL.
- `sessionStore.has(...)` should remain self-healing: stale sessions should clear before they can block users.
