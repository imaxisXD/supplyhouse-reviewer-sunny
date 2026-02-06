import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { createLogger } from "../config/logger.ts";

export interface RepoDocListItem {
  id: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoDoc extends RepoDocListItem {
  body: string;
}

export interface RepoDocSummary {
  repoId: string;
  hasDocs: boolean;
  docCount: number;
  summaryMarkdown: string;
  latestUpdatedAt?: string | null;
}

export interface RepoDocChunk {
  content: string;
  docId: string;
  title: string;
  chunkIndex: number;
}

const log = createLogger("repo-docs");
const DB_PATH = process.env.REPO_DOCS_DB_PATH ?? "data/docs.db";
let db: Database | null = null;

function initRepoDocsDb(database: Database): void {
  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS repo_docs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repo_docs_repo_id ON repo_docs(repo_id);

    CREATE TABLE IF NOT EXISTS repo_doc_chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repo_doc_chunks_doc_id ON repo_doc_chunks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_repo_doc_chunks_repo_id ON repo_doc_chunks(repo_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS repo_doc_chunks_fts USING fts5(
      content,
      repo_id,
      doc_id,
      chunk_index,
      content='repo_doc_chunks',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync with repo_doc_chunks automatically
    CREATE TRIGGER IF NOT EXISTS repo_doc_chunks_ai AFTER INSERT ON repo_doc_chunks BEGIN
      INSERT INTO repo_doc_chunks_fts(rowid, content, repo_id, doc_id, chunk_index)
      VALUES (new.rowid, new.content, new.repo_id, new.doc_id, new.chunk_index);
    END;
    CREATE TRIGGER IF NOT EXISTS repo_doc_chunks_ad AFTER DELETE ON repo_doc_chunks BEGIN
      INSERT INTO repo_doc_chunks_fts(repo_doc_chunks_fts, rowid, content, repo_id, doc_id, chunk_index)
      VALUES ('delete', old.rowid, old.content, old.repo_id, old.doc_id, old.chunk_index);
    END;
    CREATE TRIGGER IF NOT EXISTS repo_doc_chunks_au AFTER UPDATE ON repo_doc_chunks BEGIN
      INSERT INTO repo_doc_chunks_fts(repo_doc_chunks_fts, rowid, content, repo_id, doc_id, chunk_index)
      VALUES ('delete', old.rowid, old.content, old.repo_id, old.doc_id, old.chunk_index);
      INSERT INTO repo_doc_chunks_fts(rowid, content, repo_id, doc_id, chunk_index)
      VALUES (new.rowid, new.content, new.repo_id, new.doc_id, new.chunk_index);
    END;
  `);
}

function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    initRepoDocsDb(db);
    log.info({ path: DB_PATH }, "Repo docs database initialized");
  }
  return db;
}

export function ensureRepoDocsDb(): void {
  getDb();
}

export function listRepoDocs(repoId: string): RepoDocListItem[] {
  const database = getDb();
  const rows = database
    .query(
      `SELECT
        id,
        repo_id as repoId,
        title,
        created_at as createdAt,
        updated_at as updatedAt
      FROM repo_docs
      WHERE repo_id = ?
      ORDER BY updated_at DESC`,
    )
    .all(repoId) as RepoDocListItem[];
  return rows;
}

export function getRepoDocById(docId: string): RepoDoc | null {
  const database = getDb();
  const row = database
    .query(
      `SELECT
        id,
        repo_id as repoId,
        title,
        body,
        created_at as createdAt,
        updated_at as updatedAt
      FROM repo_docs
      WHERE id = ?`,
    )
    .get(docId) as RepoDoc | undefined;
  return row ?? null;
}

export function createRepoDoc(input: { repoId: string; title: string; body: string }): RepoDoc {
  const database = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .query(
      `INSERT INTO repo_docs (id, repo_id, title, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.repoId, input.title, input.body, now, now);

  reindexDocChunks(id, input.repoId, input.body);

  return {
    id,
    repoId: input.repoId,
    title: input.title,
    body: input.body,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateRepoDoc(docId: string, input: { title: string; body: string }): RepoDoc | null {
  const database = getDb();
  const now = new Date().toISOString();
  const result = database
    .query(
      `UPDATE repo_docs
       SET title = ?, body = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(input.title, input.body, now, docId);

  if (result.changes === 0) return null;

  const updated = getRepoDocById(docId);
  if (!updated) return null;

  reindexDocChunks(docId, updated.repoId, input.body);
  return updated;
}

export function deleteRepoDoc(docId: string): boolean {
  const database = getDb();
  // Chunks + FTS cleaned up via trigger (external-content FTS5)
  database.query("DELETE FROM repo_doc_chunks WHERE doc_id = ?").run(docId);
  const result = database.query("DELETE FROM repo_docs WHERE id = ?").run(docId);
  return result.changes > 0;
}

function splitMarkdownIntoChunks(content: string, minSize = 800, maxSize = 1200): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current.join("\n").trim());
  }

  const chunks: string[] = [];

  for (const section of sections) {
    const paragraphs = section
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    let chunk = "";
    for (const paragraph of paragraphs) {
      if (!chunk) {
        chunk = paragraph;
        continue;
      }

      const candidate = `${chunk}\n\n${paragraph}`;
      if (candidate.length <= maxSize) {
        chunk = candidate;
        continue;
      }

      if (chunk.length >= minSize) {
        chunks.push(chunk);
        chunk = paragraph;
        continue;
      }

      if (paragraph.length > maxSize) {
        chunks.push(chunk);
        chunk = "";
        for (let i = 0; i < paragraph.length; i += maxSize) {
          chunks.push(paragraph.slice(i, i + maxSize));
        }
        continue;
      }

      chunks.push(chunk);
      chunk = paragraph;
    }

    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks.map((c) => c.trim()).filter(Boolean);
}

export function reindexDocChunks(docId: string, repoId: string, body: string): void {
  const database = getDb();
  const now = new Date().toISOString();

  // Delete old chunks — FTS rows are cleaned up automatically via trigger
  database.query("DELETE FROM repo_doc_chunks WHERE doc_id = ?").run(docId);

  const chunks = splitMarkdownIntoChunks(body);
  if (chunks.length === 0) return;

  const insertChunk = database.query(
    `INSERT INTO repo_doc_chunks (id, doc_id, repo_id, chunk_index, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // Only insert into repo_doc_chunks — trigger auto-populates FTS
  chunks.forEach((chunk, index) => {
    const chunkId = randomUUID();
    insertChunk.run(chunkId, docId, repoId, index, chunk, now);
  });
}

export function searchRepoDocChunks(repoId: string, query: string, limit = 6): RepoDocChunk[] {
  if (!query.trim()) return [];
  const database = getDb();
  const rows = database
    .query(
      `SELECT
        repo_doc_chunks_fts.content as content,
        repo_doc_chunks_fts.doc_id as docId,
        repo_doc_chunks_fts.chunk_index as chunkIndex,
        d.title as title,
        bm25(repo_doc_chunks_fts) as score
      FROM repo_doc_chunks_fts
      JOIN repo_docs d ON d.id = repo_doc_chunks_fts.doc_id
      WHERE repo_doc_chunks_fts.repo_id = ? AND repo_doc_chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?`,
    )
    .all(repoId, query, limit) as RepoDocChunk[];
  return rows;
}

function extractFirstHeading(body: string): string | null {
  const match = body.match(/^#{1,6}\s+(.+)$/m);
  return match ? match[1]?.trim() ?? null : null;
}

function extractFirstParagraph(body: string): string | null {
  const paragraphs = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return null;
  return paragraphs[0] ?? null;
}

export function buildRepoDocsSummary(repoId: string, maxChars = 4000): RepoDocSummary {
  const database = getDb();
  const rows = database
    .query(
      `SELECT
        id,
        title,
        body,
        updated_at as updatedAt
      FROM repo_docs
      WHERE repo_id = ?
      ORDER BY updated_at DESC`,
    )
    .all(repoId) as Array<{ id: string; title: string; body: string; updatedAt: string }>;

  if (rows.length === 0) {
    return {
      repoId,
      hasDocs: false,
      docCount: 0,
      summaryMarkdown: "",
      latestUpdatedAt: null,
    };
  }

  const pieces: string[] = [];
  let latestUpdatedAt: string | null = null;

  for (const doc of rows) {
    if (!latestUpdatedAt || doc.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = doc.updatedAt;
    }

    const heading = extractFirstHeading(doc.body);
    const paragraph = extractFirstParagraph(doc.body);

    pieces.push(`### ${doc.title}`);
    if (heading) pieces.push(`_Section_: ${heading}`);
    if (paragraph) {
      const trimmed = paragraph.length > 420 ? `${paragraph.slice(0, 420)}…` : paragraph;
      pieces.push(trimmed);
    }
    pieces.push("");
  }

  let summaryMarkdown = pieces.join("\n").trim();
  if (summaryMarkdown.length > maxChars) {
    summaryMarkdown = `${summaryMarkdown.slice(0, maxChars)}…`;
  }

  return {
    repoId,
    hasDocs: true,
    docCount: rows.length,
    summaryMarkdown,
    latestUpdatedAt,
  };
}
