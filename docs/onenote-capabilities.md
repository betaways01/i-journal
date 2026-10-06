# OneNote capabilities (frozen 2026-08-22)

Proven against a personal Microsoft account via Microsoft Graph. This is the power list the agent should assume. Do not rediscover it by stuffing the whole account into a prompt.

## Auth

- Azure app `i-journal` already exists in the personal directory (`MICROSOFT_CLIENT_ID` / `SECRET` in `.env`).
- Working redirect URIs: `https://i-journal-production.up.railway.app/auth/callback` (Web) and `http://localhost:3002/auth/callback` (SPA).
- Personal account tokens are compact MSA tokens, not JWTs. They work with Graph OneNote.
- SPA token refresh must send `Origin: http://localhost:3002`.
- Required delegated scopes: `Notes.ReadWrite`, `User.Read`, `offline_access`.
- Graph OneNote is delegated-user only. App-only auth is not a path.

## Powers (proven)

Create
- Notebooks, sections, pages.
- Page title in `<title>` becomes OneNote Page Title.
- Native **Heading 1–6** via `<h1>`–`<h6>`.
- Normal body via `<p>`.
- Bold `<b>` / italic `<i>` / lists `<ul><ol>`.
- **Red (and other) text colour** via `style="color:#c42b1c"` on `<p>` or `<span>`.
- Citation-like line via `<cite>` (renders small gray).
- One image per create, multipart `img src="name:part"`.
- One audio file per write, `<object data-attachment="file.m4a" data="name:part" type="audio/mp4" />`.

Update
- PATCH `/me/onenote/pages/{id}/content` with JSON commands.
- Named regions: put `data-id` on divs at create time (`morning`, `evening`, …), then `target: "#evening"` append/replace children.
- Replace an image using the generated `img:{guid}{n}` id from `GET .../content?includeIDs=true`.
- Append audio/objects the same way.
- Heading/paragraph replace by generated id.

Delete
- `DELETE /me/onenote/pages/{id}` works for healthy pages.
- A page whose resources failed (client shows “Content Not Yet Available”) may 404 on GET/DELETE and has to be removed in the OneNote app.

Read
- `GET /me/onenote/pages/{id}/content` returns HTML. Large notes (~17k) are fine.
- `GET .../content?includeIDs=true` is required before a surgical PATCH.

Locate (the method to keep)

Do **not** use global `$search` or `$filter` on `/me/onenote/pages`. Personal account with many sections returns `20108` / `20266`.

Always:

1. Catalog notebooks (names + ids). Cache this; do not refetch every turn.
2. Route the ask to one notebook (your “folders” **are** the notebooks, e.g. `Personal`, `Work`, `i-Journal`). No nested section groups on this account.
3. Route to one section (`August 2026`, `MONEY`, `Leadership`, `Daily Entries`).
4. List that section’s pages. Match title/date client-side.
5. `GET` **one** page. Cite the path: `Notebook / Section / Title`.
6. If the named month section is missing, say so, then look in the newest same-year section for a page dated this month (e.g. 2 Aug 2026 lived in `Sunday Service / July 2026`).

Proven locates: `i-Journal / Daily Entries / 2026-03-30 — Monday`; `Sunday Service / July 2026 / Laying A Foundation: Joseph Kahonoki`; `Personal / MONEY / Business`; `Discipleship Class / 1. Justification by Faith`.

## Do not assume

- Global search.
- Nested section groups (none on this account).
- `<blockquote>` or `<pre>` — Graph strips them. Fake Quote/Code with italic indent / Consolas `<p>` if needed.
- Two images in one create. One image on the lab Friday page worked. Two photos on another page produced an empty “Content Not Yet Available” page. Until re-proven: **one binary per write**, then PATCH more.
- Video — untested.
- Tappable `<a href>` — not explicitly proven, likely fine.
- Ink / handwriting API.

## Lab sandbox

- Notebook: `i-Journal Lab`
- Section: `Capability Tests`
- Known good page: `2026-08-21 — Friday` (headings, red text, cat image, m4a audio).
- Do not use real journals (`i-Journal / Daily Entries` or any personal notebook) as write tests.

## Daily-page pattern (journal archive)

Capture is freeform (Telegram). Archive is structured:

- One page per day, title `YYYY-MM-DD — Weekday`.
- Named divs: `morning`, `stream`, `evening`, `closing`.
- Morning creates the page. Later writes PATCH the region. Do not blind-append a second novel.
- H2 Morning/Evening, H3 life areas only when there is signal.

## Agent contract

OneNote is the library + the daily book. It is not identity. Retrieved pages go in **turn-dynamic** context, cited, budgeted, discarded after the turn. Never paste the corpus into SOUL/USER/MEMORY.
