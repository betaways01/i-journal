import { getDb } from './index';
import { WorkspaceDoc, WorkspaceDocKey } from '../agent/types';

interface WorkspaceDocRow {
  user_id: number;
  doc_key: string;
  content_markdown: string;
  updated_at: string;
}

function rowToDoc(row: WorkspaceDocRow): WorkspaceDoc {
  return {
    userId: row.user_id,
    key: row.doc_key as WorkspaceDocKey,
    content: row.content_markdown,
    updatedAt: row.updated_at,
  };
}

export function getWorkspaceDoc(userId: number, key: WorkspaceDocKey): WorkspaceDoc | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agent_workspace_docs WHERE user_id = ? AND doc_key = ?')
    .get(userId, key) as WorkspaceDocRow | undefined;
  return row ? rowToDoc(row) : null;
}

export function listWorkspaceDocs(userId: number): WorkspaceDoc[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM agent_workspace_docs WHERE user_id = ? ORDER BY doc_key ASC')
    .all(userId)
    .map((row) => rowToDoc(row as WorkspaceDocRow));
}

export function upsertWorkspaceDoc(userId: number, key: WorkspaceDocKey, content: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_workspace_docs (user_id, doc_key, content_markdown, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, doc_key) DO UPDATE SET
       content_markdown = excluded.content_markdown,
       updated_at = excluded.updated_at`
  ).run(userId, key, content, now, now);
}

export function ensureWorkspaceDocs(
  userId: number,
  docs: Array<{ key: WorkspaceDocKey; content: string }>
): void {
  for (const doc of docs) {
    if (!getWorkspaceDoc(userId, doc.key)) {
      upsertWorkspaceDoc(userId, doc.key, doc.content);
    }
  }
}
