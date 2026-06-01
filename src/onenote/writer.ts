import {
  getStoredMicrosoftConnectionSummary,
  getValidLegacyOwnerAccessToken,
  getValidMicrosoftAccessTokenForUser,
  refreshLegacyOwnerAccessToken,
  refreshMicrosoftAccessTokenForUser,
  ONENOTE_LICENSE_HINT,
} from './auth';
import { hasLegacyOwnerOneNoteConfigured } from '../config';
import { deleteStorageConnectionForUser } from '../db/storageConnections.repo';
import { UserRow } from '../db/users.repo';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const NOTEBOOK_NAME = 'i-Journal';
const SECTION_NAME = 'Daily Entries';

export interface OneNoteStatus {
  connected: boolean;
  source: 'user_oauth' | 'legacy_owner_env' | 'none';
  profileName?: string;
  email?: string | null;
}

function markdownToXhtml(markdown: string): string {
  let html = markdown
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
  const stored = getStoredMicrosoftConnectionSummary(user.id);
  if (stored?.connected) {
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

async function findOrCreateNotebook(user: UserRow): Promise<string> {
  const res = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/notebooks`);
  if (!res.ok) throw new Error(`Failed to list notebooks: ${await res.text()}`);

  const data = (await res.json()) as { value: { displayName: string; id: string }[] };
  const notebook = data.value.find((nb) => nb.displayName === NOTEBOOK_NAME);

  if (notebook) return notebook.id;

  const createRes = await graphRequestForUser(user, `${GRAPH_BASE}/me/onenote/notebooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: NOTEBOOK_NAME }),
  });

  if (!createRes.ok) throw new Error(`Failed to create notebook: ${await createRes.text()}`);

  const created = (await createRes.json()) as { id: string };
  console.log(`[OneNote] Created notebook for user ${user.telegram_id}: ${NOTEBOOK_NAME}`);
  return created.id;
}

async function findOrCreateSection(user: UserRow, notebookId: string): Promise<string> {
  const res = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`
  );
  if (!res.ok) throw new Error(`Failed to list sections: ${await res.text()}`);

  const data = (await res.json()) as { value: { displayName: string; id: string }[] };
  const section = data.value.find((s) => s.displayName === SECTION_NAME);

  if (section) return section.id;

  const createRes = await graphRequestForUser(
    user,
    `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: SECTION_NAME }),
    }
  );

  if (!createRes.ok) throw new Error(`Failed to create section: ${await createRes.text()}`);

  const created = (await createRes.json()) as { id: string };
  console.log(`[OneNote] Created section for user ${user.telegram_id}: ${SECTION_NAME}`);
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
  const notebookId = await findOrCreateNotebook(user);
  return findOrCreateSection(user, notebookId);
}

function buildPageXhtml(title: string, markdownContent: string): string {
  const bodyHtml = markdownToXhtml(markdownContent);

  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

export function getOneNoteStatusForUser(user: UserRow): OneNoteStatus {
  const stored = getStoredMicrosoftConnectionSummary(user.id);
  if (stored?.connected) {
    return {
      connected: true,
      source: 'user_oauth',
      profileName: stored.profileName,
      email: stored.email,
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

  const pageData = (await res.json()) as { links?: { oneNoteWebUrl?: { href?: string } } };
  const webUrl = pageData.links?.oneNoteWebUrl?.href || null;

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

  const pageData = (await res.json()) as { links?: { oneNoteWebUrl?: { href?: string } } };
  const webUrl = pageData.links?.oneNoteWebUrl?.href || null;

  console.log(`[OneNote] Evening entry saved for user ${user.telegram_id}: ${title}`);
  return webUrl;
}
