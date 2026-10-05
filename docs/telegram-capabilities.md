# Telegram capabilities (frozen 2026-08-24)

Channel tests against the production bot in the owner DM. OneNote is the book; Telegram is how life arrives. This file is the power list and the test log. The agent is not specified here.

## Live inbound (2026-08-24)

`getUpdates` polling (webhook was dead). Four owner messages landed and were downloaded:

| What you sent | Telegram delivered |
|---|---|
| Swipe-reply `Hi. Woow` on the lab cat | `text` + `reply_to_message` with **photo + caption** |
| Voice note, 4s | `voice` `audio/ogg` Opus 48 kHz, 99 KB |
| Photo, no caption | `photo` (4 sizes), JPEG 567×1280 |
| Circle video, 4s | `video_note` MP4, 482 KB |

Queued messages still arrived ~20 minutes later. Telegram keeps updates ~24h if nothing is polling.

Quote-slice (`message.quote`) and inline `callback_query` were not in this batch. Outbound quote-reply worked on **plaintext** and failed on the HTML gallery (`QUOTE_TEXT_INVALID`).

## Live outbound (2026-08-24)

Worked: HTML bold/italic/underline/strike/spoiler/code/blockquote/links/emoji; reply to own message; reactions; inline buttons; reply keyboard; force-reply; photo+HTML caption; `sendVoice`; dice; chat actions `typing` / `record_voice`; `editMessageText`.

Does **not** work: coloured body text (no red in Telegram). That stays OneNote.

## Capture contract (code, 2026-08-24)

`src/bot/capture.ts` + `bot.on('message')`.

- A swipe-reply is a **pointer**, not extra caption text. We keep target `message_id`, kinds (`photo`/`voice`/…), caption/text if any, `file_id`s, and optional `quote`.
- Captionless photo/voice as the target is still a valid reply.
- Voice/photo/video/video_note/document/sticker/animation are first-class sends, not dropped.
- Bytes are saved under `data/telegram-inbox/<telegramId>/` (gitignored). Transcription/vision are later; download is the Telegram job.
- Commands (`/…`) still go through `bot.command` and are skipped here.
- The companion still receives a **string** (`formatCaptureForAgent`) so the current agent loop does not change. Structured fields exist on `InboundCapture` for the next layer.

Example string after `Hi. Woow` on the cat:

```
[replying to photo #1329]
[target text: Photo + HTML caption…]
[target photo 520x225 saved 1329-photo.jpg]
Hi. Woow
```

## Inventions (primitives → later product moves)

| Primitive | Move |
|---|---|
| Swipe-reply / quote-slice | Bind this turn to that bubble or sentence |
| Voice | Keep audio + transcript; answer only if it is a question |
| Photo / short video / video_note | File with caption, or decode if asked. One binary per OneNote write until two-at-once is proven |
| Caption | First-class text |
| Reaction + edit-in-place | Quiet ack / “saving…” |
| Chat action | Presence while we work |
| Force-reply | Pin one question |
| Reply keyboard | Rare mode switch, then hide |
| Inline buttons | Save / Look / Later — never a cage |
| Forward into the chat | File this from elsewhere |

## Still unproven live (API exists)

- Quote-slice inbound
- Inline button tap inbound
- Landscape `video` (we have `video_note`)
- Reply to a **captionless** photo/voice (cat had a caption)
- Albums (`media_group_id`), docs, forwards, edits

## Do not assume

- Telegram will transcribe or OCR. We `getFile`, then STT/vision.
- Native text colour.
- HTML quote-reply is reliable; quote against visible plaintext.
- A dead webhook still receives. Use a live poller or a living webhook URL.
- Two pollers at once (`409 Conflict`).

## Lab scripts

- `scripts/telegram-lab.py` — outbound showcase
- `scripts/telegram-inbox.py` / `telegram-listen.py` — inbound dump
- Samples: `state/telegram-inbox/`
