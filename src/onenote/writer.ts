import {
  getStoredMicrosoftConnectionSummary,
  getValidLegacyOwnerAccessToken,
  getValidMicrosoftAccessTokenForUser,
  refreshLegacyOwnerAccessToken,
  refreshMicrosoftAccessTokenForUser,
  ONENOTE_LICENSE_HINT,
} from './auth';
import { hasLegacyOwnerOneNoteConfigured } from '../config';
import {
  deleteStorageConnectionForUser,
  getStorageConnectionForUser,
} from '../db/storageConnections.repo';
import { UserRow } from '../db/users.repo';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_NOTEBOOK_NAME = 'i-Journal';
const DEFAULT_SECTION_NAME = 'Daily Entries';

/**
 * Where this user's journal goes in OneNote. The user can change it (set_onenote_location),
 * stored in the connection metadata; defaults to the i-Journal / Daily Entries names.
 * Nothing here is hardcoded to a single place anymore.
 */
function oneNoteTargetForUser(user: UserRow): { notebook: string; section: string } {
  const md = getStorageConnectionForUser(user.id, 'onenote')?.metadata ?? {};
  const notebook = typeof md.notebook === 'string' && md.notebook.trim() ? md.notebook.trim() : DEFAULT_NOTEBOOK_NAME;
  const section = typeof md.section === 'string' && md.section.trim() ? md.section.trim() : DEFAULT_SECTION_NAME;
  return { notebook, section };
}

export function getOneNoteTargetForUser(user: UserRow): { notebook: string; section: string } {
  return oneNoteTargetForUser(user);
}

export interface OneNoteStatus {
  connected: boolean;
  source: 'user_oauth' | 'legacy_owner_env' | 'none';
  profileName?: string;
  email?: string | null;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToXhtml(markdown: string): string {
  // Escape the user's raw text FIRST so &, <, > in their content become entities; the markdown
  // replacements below then add real <h2>/<b>/<p> tags that are not double-escaped. Without
  // this, content like "me & you <3" produced invalid XHTML and the page write failed.
  let html = escapeXml(markdown)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/^---$/gm, '<hr/>')
    .replace(/^- (.+)$/gm, '<p>\u2022 $1</p>');

  const lines = html.split('\n');
  const wrapped = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<p') ||
      trimmed.startsWith('<hr') ||
      trimmed.startsWith('<b') ||
      trimmed.startsWith('<i')
    ) {
      return trimmed;
    }
    return `<p>${trimmed}</p>`;
  });

  return wrapped.filter(Boolean).join('\n');
}

async function getAuthModeForUser(user: UserRow): Promise<{
  source: 'user_oauth' | 'legacy_owner_env';
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
} | null> {
  // A connection counts as OAuth only if it actually holds tokens. A metadata-only row
  // (used to remember the legacy owner's chosen notebook/section) must NOT hijack the auth
  // path — the owner keeps using their env tokens.
  const conn = getStorageConnectionForUser(user.id, 'onenote');
  if (conn && (conn.access_token || conn.refresh_token)) {
    return {
      source: 'user_oauth',
      getAccessToken: () => getValidMicrosoftAccessTokenForUser(user.id),
      refreshAccessToken: async () => {
        const refreshed = await refreshMicrosoftAccessTokenForUser(user.id);
        if (!refreshed.access_token) {
          throw new Error('No refreshed OneNote access token available for this user.');
        }
        return refreshed.access_token;
      },
    };
  }

  if (user.is_owner === 1 && hasLegacyOwnerOneNoteConfigured()) {
    return {
      source: 'legacy_owner_env',
      getAccessToken: () => getValidLegacyOwnerAccessToken(),
      refreshAccessToken: () => refreshLegacyOwnerAccessToken(),
    };
  }

  return null;
}

async function graphRequestForUser(
  user: UserRow,
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const authMode = await getAuthModeForUser(user);
  if (!authMode) {
    throw new Error('No OneNote connection found for this user.');
  }

  let token = await authMode.getAccessToken();

  let response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (response.status === 401) {
    console.log(`[OneNote] Token expired for user ${user.telegram_id}, refreshing...`);
    token = await authMode.refreshAccessToken();
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
  }

  return response;
}

async function findOrCreateNotebook(user: UserRow, notebookName: string): Promise<string> {
  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/notebooks`);
  if (!res.ok) throw new Error(`Failed to list notebooks: ${await res.text()}`);

  const data = (await res.json()) as { value: { displayName: string; id: string }[] };
  const notebook = data.value.find((nb) => nb.displayName === notebookName);

  if (notebook) return notebook.id;

  const createRes = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/notebooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: notebookName }),
  });

  if (!createRes.ok) throw new Error(`Failed to create notebook: ${await createRes.text()}`);

  const created = (await createRes.json()) as { id: string };
  console.log(`[OneNote] Created notebook for user ${user.telegram_id}: ${notebookName}`);
  return created.id;
}

async function findOrCreateSection(
  user: UserRow,
  notebookId: string,
  sectionName: string
): Promise<string> {
  const res = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`
  );
  if (!res.ok) throw new Error(`Failed to list sections: ${await res.text()}`);

  const data = (await res.json()) as { value: { displayName: string; id: string }[] };
  const section = data.value.find((s) => s.displayName === sectionName);

  if (section) return section.id;

  const createRes = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: sectionName }),
    }
  );

  if (!createRes.ok) throw new Error(`Failed to create section: ${await createRes.text()}`);

  const created = (await createRes.json()) as { id: string };
  console.log(`[OneNote] Created section for user ${user.telegram_id}: ${sectionName}`);
  return created.id;
}

async function findPageByTitle(
  user: UserRow,
  sectionId: string,
  title: string
): Promise<string | null> {
  const encoded = encodeURIComponent(title).replace(/'/g, '%27');
  const res = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages?$filter=title eq '${encoded}'&$select=id,title`
  );

  if (!res.ok) {
    const listRes = await graphRequestForUser(
      user,
      `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages?$select=id,title&$top=10&$orderby=createdDateTime desc`
    );
    if (!listRes.ok) return null;

    const listData = (await listRes.json()) as { value: { id: string; title: string }[] };
    const page = listData.value.find((entry) => entry.title === title);
    return page ? page.id : null;
  }

  const data = (await res.json()) as { value: { id: string; title: string }[] };
  return data.value.length > 0 ? data.value[0].id : null;
}

async function appendToPage(user: UserRow, pageId: string, htmlContent: string): Promise<void> {
  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/pages/${pageId}/content`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        target: 'body',
        action: 'append',
        content: htmlContent,
      },
    ]),
  });

  if (!res.ok) {
    throw new Error(`Failed to append to OneNote page: ${await res.text()}`);
  }
}

async function getSectionId(user: UserRow): Promise<string> {
  const { notebook, section } = oneNoteTargetForUser(user);
  const notebookId = await findOrCreateNotebook(user, notebook);
  return findOrCreateSection(user, notebookId, section);
}

/**
 * Ensure the user's chosen notebook + section exist (creating them if needed). Used after
 * the user changes their OneNote location, to validate it works and provision it.
 */
export async function ensureOneNoteLocationForUser(
  user: UserRow
): Promise<{ notebook: string; section: string }> {
  const { notebook, section } = oneNoteTargetForUser(user);
  const notebookId = await findOrCreateNotebook(user, notebook);
  await findOrCreateSection(user, notebookId, section);
  return { notebook, section };
}

/**
 * Create an arbitrary OneNote page (any title/content) in the user's chosen notebook+section.
 * Powers on-demand requests like "create a test page with something interesting".
 */
export async function createOneNotePageForUser(
  user: UserRow,
  title: string,
  markdownContent: string
): Promise<string | null> {
  const sectionId = await getSectionId(user);
  const xhtml = buildPageXhtml(title, markdownContent);

  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xhtml+xml' },
    body: xhtml,
  });

  if (!res.ok) {
    const body = await res.text();
    if (body.includes('30121') || /SharePoint license/i.test(body) || /tenant does not have/i.test(body)) {
      throw new Error(ONENOTE_LICENSE_HINT);
    }
    throw new Error(`Failed to create OneNote page (${res.status}). ${body.slice(0, 200)}`);
  }

  const pageData = (await res.json()) as { links?: PageLinks };
  console.log(`[OneNote] Page created for user ${user.telegram_id}: ${title}`);
  return preferredPageUrl(pageData.links);
}

interface PageLinks {
  oneNoteClientUrl?: { href?: string };
  oneNoteWebUrl?: { href?: string };
}

/** Prefer the app (client) URL so "Open in OneNote" opens the OneNote app, not the web. */
function preferredPageUrl(links?: PageLinks): string | null {
  return links?.oneNoteClientUrl?.href || links?.oneNoteWebUrl?.href || null;
}

function isOneNoteLicenseError(body: string): boolean {
  return body.includes('30121') || /SharePoint license/i.test(body) || /tenant does not have/i.test(body);
}

export interface OneNotePageHit {
  id: string;
  title: string;
  appUrl: string | null;
  webUrl: string | null;
  lastModified: string | null;
}

/**
 * Search the user's OneNote pages. Primary path is Graph full-text $search; if a tenant/account
 * doesn't support it, fall back to listing recent pages and filtering by title. Read-only.
 */
export async function searchOneNotePagesForUser(
  user: UserRow,
  query: string,
  limit = 8
): Promise<OneNotePageHit[]> {
  const top = Math.min(Math.max(limit, 1), 50);
  const clean = query.replace(/"/g, '').trim();
  const enc = encodeURIComponent(`"${clean}"`);

  let pages: Record<string, unknown>[] = [];
  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/pages?$search=${enc}&$top=${top}`);
  if (res.ok) {
    pages = ((await res.json()) as { value?: Record<string, unknown>[] }).value ?? [];
  } else {
    const body = await res.text();
    if (isOneNoteLicenseError(body)) throw new Error(ONENOTE_LICENSE_HINT);
    // Fallback: most-recently-modified pages, filtered by title client-side.
    const listRes = await graphRequestForUser(
      user,
      `${GRAPH_BASE}/me/onenote/pages?$top=100&$orderby=lastModifiedDateTime%20desc`
    );
    if (!listRes.ok) {
      const body2 = await listRes.text();
      if (isOneNoteLicenseError(body2)) throw new Error(ONENOTE_LICENSE_HINT);
      throw new Error(`OneNote search failed (${listRes.status}). ${body2.slice(0, 160)}`);
    }
    const all = ((await listRes.json()) as { value?: Record<string, unknown>[] }).value ?? [];
    const q = clean.toLowerCase();
    pages = all
      .filter((p) => typeof p.title === 'string' && (p.title as string).toLowerCase().includes(q))
      .slice(0, top);
  }

  return pages.map((p) => {
    const links = p.links as PageLinks | undefined;
    return {
      id: String(p.id ?? ''),
      title: typeof p.title === 'string' && p.title ? (p.title as string) : '(untitled page)',
      appUrl: links?.oneNoteClientUrl?.href ?? null,
      webUrl: links?.oneNoteWebUrl?.href ?? null,
      lastModified: typeof p.lastModifiedDateTime === 'string' ? (p.lastModifiedDateTime as string) : null,
    };
  });
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 4000 ? `${text.slice(0, 4000).trimEnd()}\n…(truncated)` : text;
}

/** Read a OneNote page's content (by page id), returned as plain text. Read-only. */
export async function readOneNotePageForUser(user: UserRow, pageId: string): Promise<string> {
  const res = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/pages/${encodeURIComponent(pageId)}/content`
  );
  if (!res.ok) {
    const body = await res.text();
    if (isOneNoteLicenseError(body)) throw new Error(ONENOTE_LICENSE_HINT);
    throw new Error(`Couldn't read that OneNote page (${res.status}).`);
  }
  const html = await res.text();
  return htmlToText(html);
}

function buildPageXhtml(title: string, markdownContent: string): string {
  const bodyHtml = markdownToXhtml(markdownContent);

  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeXml(title)}</title>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

export function getOneNoteStatusForUser(user: UserRow): OneNoteStatus {
  // Token-bearing row = real OAuth connection. A metadata-only row (no tokens) is just stored
  // settings and must not be reported as an OAuth connection.
  const conn = getStorageConnectionForUser(user.id, 'onenote');
  if (conn && (conn.access_token || conn.refresh_token)) {
    const md = conn.metadata ?? {};
    return {
      connected: true,
      source: 'user_oauth',
      profileName: typeof md.displayName === 'string' ? md.displayName : undefined,
      email: typeof md.email === 'string' ? md.email : null,
    };
  }

  if (user.is_owner === 1 && hasLegacyOwnerOneNoteConfigured()) {
    return {
      connected: true,
      source: 'legacy_owner_env',
      profileName: 'legacy server connection',
      email: null,
    };
  }

  return {
    connected: false,
    source: 'none',
  };
}

export function disconnectStoredOneNoteForUser(user: UserRow): {
  disconnected: boolean;
  nowUsingLegacyFallback: boolean;
} {
  const stored = getStoredMicrosoftConnectionSummary(user.id);
  if (stored?.connected) {
    deleteStorageConnectionForUser(user.id, 'onenote');
    return {
      disconnected: true,
      nowUsingLegacyFallback: user.is_owner === 1 && hasLegacyOwnerOneNoteConfigured(),
    };
  }

  return {
    disconnected: false,
    nowUsingLegacyFallback: user.is_owner === 1 && hasLegacyOwnerOneNoteConfigured(),
  };
}

export async function testOneNoteConnectionForUser(user: UserRow): Promise<{
  displayName: string;
  email: string | null;
}> {
  // Real test: can we actually reach OneNote NOTEBOOKS — not just the profile? The old
  // check only hit /me, which succeeds for any account, so it reported "looks good" even
  // when every save would fail with the SharePoint-license error.
  const notebooksRes = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/notebooks?$top=1`
  );

  if (!notebooksRes.ok) {
    const body = await notebooksRes.text();
    if (body.includes('30121') || /SharePoint license/i.test(body) || /tenant does not have/i.test(body)) {
      throw new Error(ONENOTE_LICENSE_HINT);
    }
    throw new Error(`OneNote isn't reachable right now (${notebooksRes.status}). ${body.slice(0, 200)}`);
  }

  const res = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me?$select=displayName,mail,userPrincipalName`
  );

  if (!res.ok) {
    throw new Error(`Failed to read your Microsoft profile: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    displayName?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
  };

  return {
    displayName: data.displayName || 'OneNote user',
    email: data.mail || data.userPrincipalName || null,
  };
}

export async function writeMorningToOneNoteForUser(
  user: UserRow,
  dateStr: string,
  dayStr: string,
  markdownContent: string
): Promise<string | null> {
  const sectionId = await getSectionId(user);
  const title = `${dateStr} \u2014 ${dayStr}`;
  const xhtml = buildPageXhtml(title, markdownContent);

  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xhtml+xml' },
    body: xhtml,
  });

  if (!res.ok) {
    throw new Error(`Failed to create OneNote page: ${await res.text()}`);
  }

  const pageData = (await res.json()) as { links?: PageLinks };
  const webUrl = preferredPageUrl(pageData.links);

  console.log(`[OneNote] Morning entry saved for user ${user.telegram_id}: ${title}`);
  return webUrl;
}

export async function writeEveningToOneNoteForUser(
  user: UserRow,
  dateStr: string,
  dayStr: string,
  markdownContent: string
): Promise<string | null> {
  const sectionId = await getSectionId(user);
  const title = `${dateStr} \u2014 ${dayStr}`;
  const existingPageId = await findPageByTitle(user, sectionId, title);

  if (existingPageId) {
    const bodyHtml = markdownToXhtml(markdownContent);
    await appendToPage(user, existingPageId, `<hr/>\n${bodyHtml}`);
    console.log(`[OneNote] Evening entry appended for user ${user.telegram_id}: ${title}`);
    return null;
  }

  const xhtml = buildPageXhtml(title, markdownContent);
  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xhtml+xml' },
    body: xhtml,
  });

  if (!res.ok) {
    throw new Error(`Failed to create OneNote page: ${await res.text()}`);
  }

  const pageData = (await res.json()) as { links?: PageLinks };
  const webUrl = preferredPageUrl(pageData.links);

  console.log(`[OneNote] Evening entry saved for user ${user.telegram_id}: ${title}`);
  return webUrl;
}
