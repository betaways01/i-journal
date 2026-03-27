import { getValidToken, refreshAccessToken } from './auth';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const NOTEBOOK_NAME = 'i-Journal';
const SECTION_NAME = 'Daily Entries';

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

async function graphRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  let token = await getValidToken();

  let response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (response.status === 401) {
    console.log('[OneNote] Token expired, refreshing...');
    token = await refreshAccessToken();
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

async function findOrCreateNotebook(): Promise<string> {
  const res = await graphRequest(`${GRAPH_BASE}/me/onenote/notebooks`);
  if (!res.ok) throw new Error(`Failed to list notebooks: ${await res.text()}`);

  const data = (await res.json()) as { value: { displayName: string; id: string }[] };
  const notebook = data.value.find((nb) => nb.displayName === NOTEBOOK_NAME);

  if (notebook) return notebook.id;

  const createRes = await graphRequest(`${GRAPH_BASE}/me/onenote/notebooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: NOTEBOOK_NAME }),
  });

  if (!createRes.ok) throw new Error(`Failed to create notebook: ${await createRes.text()}`);

  const created = (await createRes.json()) as { id: string };
  console.log(`[OneNote] Created notebook: ${NOTEBOOK_NAME}`);
  return created.id;
}

async function findOrCreateSection(notebookId: string): Promise<string> {
  const res = await graphRequest(
    `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`
  );
  if (!res.ok) throw new Error(`Failed to list sections: ${await res.text()}`);

  const data = (await res.json()) as { value: { displayName: string; id: string }[] };
  const section = data.value.find((s) => s.displayName === SECTION_NAME);

  if (section) return section.id;

  const createRes = await graphRequest(
    `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: SECTION_NAME }),
    }
  );

  if (!createRes.ok) throw new Error(`Failed to create section: ${await createRes.text()}`);

  const created = (await createRes.json()) as { id: string };
  console.log(`[OneNote] Created section: ${SECTION_NAME}`);
  return created.id;
}

async function findPageByTitle(
  sectionId: string,
  title: string
): Promise<string | null> {
  const encoded = encodeURIComponent(title).replace(/'/g, '%27');
  const res = await graphRequest(
    `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages?$filter=title eq '${encoded}'&$select=id,title`
  );

  if (!res.ok) {
    // Fallback: list all pages and find by title
    const listRes = await graphRequest(
      `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages?$select=id,title&$top=10&$orderby=createdDateTime desc`
    );
    if (!listRes.ok) return null;

    const listData = (await listRes.json()) as { value: { id: string; title: string }[] };
    const page = listData.value.find((p) => p.title === title);
    return page ? page.id : null;
  }

  const data = (await res.json()) as { value: { id: string; title: string }[] };
  return data.value.length > 0 ? data.value[0].id : null;
}

async function appendToPage(pageId: string, htmlContent: string): Promise<void> {
  const res = await graphRequest(
    `${GRAPH_BASE}/me/onenote/pages/${pageId}/content`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          target: 'body',
          action: 'append',
          content: htmlContent,
        },
      ]),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to append to OneNote page: ${await res.text()}`);
  }
}

async function getSectionId(): Promise<string> {
  const notebookId = await findOrCreateNotebook();
  return findOrCreateSection(notebookId);
}

export async function writeMorningToOneNote(
  dateStr: string,
  dayStr: string,
  markdownContent: string
): Promise<string | null> {
  const sectionId = await getSectionId();
  const title = `${dateStr} \u2014 ${dayStr}`;
  const bodyHtml = markdownToXhtml(markdownContent);

  const xhtml = `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;

  const res = await graphRequest(
    `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/xhtml+xml' },
      body: xhtml,
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to create OneNote page: ${await res.text()}`);
  }

  const pageData = (await res.json()) as { links?: { oneNoteWebUrl?: { href?: string } } };
  const webUrl = pageData.links?.oneNoteWebUrl?.href || null;

  console.log(`[OneNote] Morning entry saved: ${title}`);
  return webUrl;
}

export async function writeEveningToOneNote(
  dateStr: string,
  dayStr: string,
  markdownContent: string
): Promise<string | null> {
  const sectionId = await getSectionId();
  const title = `${dateStr} \u2014 ${dayStr}`;

  // Try to find existing page (created by morning session)
  const existingPageId = await findPageByTitle(sectionId, title);

  if (existingPageId) {
    const bodyHtml = markdownToXhtml(markdownContent);
    await appendToPage(existingPageId, `<hr/>\n${bodyHtml}`);
    console.log(`[OneNote] Evening entry appended to existing page: ${title}`);
    return null;
  }

  // No morning page — create full page
  const bodyHtml = markdownToXhtml(markdownContent);
  const xhtml = `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;

  const res = await graphRequest(
    `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/xhtml+xml' },
      body: xhtml,
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to create OneNote page: ${await res.text()}`);
  }

  const pageData = (await res.json()) as { links?: { oneNoteWebUrl?: { href?: string } } };
  const webUrl = pageData.links?.oneNoteWebUrl?.href || null;

  console.log(`[OneNote] Evening entry saved (new page): ${title}`);
  return webUrl;
}
