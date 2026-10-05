# 0004 - Treat Microsoft Graph OneNote as the archive, with folder-first locate

Date: 2026-08-22

Status: Accepted

## Context

Live Graph tests on the owner’s personal OneNote (August 2026) proved create/update/delete/read against real notebooks. Global page search fails on this account. Two images in a single create can leave a dead page in the OneNote client.

Telegram will capture; OneNote is the book and the library. The companion must not rediscover these limits the hard way.

## Decision

- Use Microsoft Graph with the existing `i-journal` Azure app and delegated `Notes.ReadWrite`.
- Locate notes by **notebook → section → page title/date**, never by global `$search`.
- Cache a catalog of notebook/section names. Retrieve one page at a time and cite the path.
- Write binaries **one per request** until multi-file create is re-proven.
- Keep a sandbox notebook `i-Journal Lab` for capability tests. Do not test writes on `i-Journal / Daily Entries` or other personal notes.
- Full inventory: [OneNote capabilities](../onenote-capabilities.md).

## Consequences

- Daily use can be accurate and cheap if the agent routes first.
- A “find this in my notes” that calls global search will fail even though the note exists.
- Photo-from-Telegram must be sequenced (create text page, PATCH image) until otherwise proven.
- Quote/Code OneNote styles are best-effort CSS, not native tags.
