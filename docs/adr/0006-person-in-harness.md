# 0006 - Grow the person in a harness, adapters last

Date: 2026-08-25

Status: Superseded (2026-10-02) by the core harness in `src/core` (see docs/runtime.md). `src/person` and `src/harness` were removed.

## Context

OneNote and Telegram are proven and frozen. The old companion is a 24h session chatbot that auto-saves and interviews. The product is a clerk with a library card: file life, or help from notes, child-simple.

Wiring Graph and Telegram first would hide person bugs behind network and UI.

## Decision

- The person lives in `src/person` and is exercised only through `src/harness`.
- Inbound shape is `InboundCapture` (the Telegram capture contract) even while Telegram is unplugged.
- Locate is folder-first against a catalog postcard + retrieved pages. Never global `$search`.
- Context is stacked: tiny SOUL, capped USER/MEMORY/IDENTITY, today/yesterday, cited corpus, uncached turn, compact session.
- Effects are the hands (`file_to_day`, `file_to_library`, `binary_write`, `remind`, `undo`, `compile_evening`). Adapters later execute them.
- Tests stay deterministic. An LLM, if added, may only compose from a Decision + hits the harness already approved.

## Consequences

- Daily use can be tested as JSON before anyone is messaged.
- A wrong citation fails a scenario instead of a live morning.
- Healing, live web, and routines are allowed to say "not in this harness" rather than fake success.
- Telegram/Graph work is integration, not personality.
