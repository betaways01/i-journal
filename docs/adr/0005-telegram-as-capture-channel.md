# 0005 - Treat Telegram as the capture channel, not a text form

Date: 2026-08-24

Status: Accepted

## Context

Live Bot API tests (owner DM, 2026-08-24) proved HTML formatting, replies, reactions, inline and reply keyboards, force-reply, photo+caption, voice, chat actions, and in-place edits. The running bot still listens only to text and ignores most of that surface. Railway webhook was dead.

OneNote is the book. Telegram is how life arrives.

## Decision

- Telegram is the **capture channel**: text, swipe-reply, quote-slice, voice, photo, short video, captions, buttons, reactions.
- Receive every message kind, not only `text`.
- Prefer HTML parse mode; do not use legacy Markdown.
- Buttons are shortcuts, never the only way.
- Transcription and vision are our jobs after `getFile`, not Telegram’s.
- Full inventory: [Telegram capabilities](../telegram-capabilities.md).

## Consequences

- A voice note or photo is a first-class journal input.
- Swipe-reply is how the user points at context; the bot must keep `reply_to_message` and `quote`.
- Until a live webhook/polling process exists, none of this reaches users.

## Implementation note (same day)

Inbound capture now uses bot.on message and src/bot/capture.ts. Media and swipe-reply targets keep kinds and file ids; bytes are stored under data/telegram-inbox/. Companion still consumes a formatted string until the agent is redesigned.
