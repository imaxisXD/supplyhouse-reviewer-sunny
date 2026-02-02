/**
 * BullMQ worker for repository indexing jobs.
 *
 * Processing pipeline:
 *   1. Clone repository (git clone via Bun.spawn)
 *   2. Detect framework
 *   3. Parse source files
 *   4. Build code knowledge graph in Memgraph
 *   5. Generate & store embeddings in Qdrant
 *
 * Progress is tracked in Redis and published via pub/sub.
 */

import { Worker, Queue } from "bullmq";
import type { Job } from "bullmq";
import { redis, publish } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { env } from "../config/env.ts";
import type { IndexJob, IndexStatus, IndexPhase } from "../types/index.ts";
import type { ParsedFile, CodeParser } from "../indexing/parsers/base.ts";
import type { CodeSnippet } from "../indexing/embedding-generator.ts";
import { typescriptParser, ensureTreeSitterLoaded as ensureTsTreeSitter } from "../indexing/parsers/typescript.ts";
import { javaParser, ensureTreeSitterLoaded as ensureJavaTreeSitter } from "../indexing/parsers/java.ts";
import { dartParser, ensureTreeSitterLoaded as ensureDartTreeSitter } from "../indexing/parsers/dart.ts";
import { ftlParser } from "../indexing/parsers/ftl.ts";
import { detectFrameworks } from "../indexing/framework-detector.ts";
import { buildGraph } from "../indexing/graph-builder.ts";
import { generateAndStoreEmbeddings } from "../indexing/embedding-generator.ts";
import { runCypher } from "../db/memgraph.ts";
import { qdrantClient } from "../db/qdrant.ts";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { deriveRepoIdFromUrl } from "../utils/repo-identity.ts";
import { collectionName } from "../indexing/embedding-generator.ts";
import { qdrantBreaker } from "../services/breakers.ts";
import { deleteToken, fetchToken } from "../utils/token-store.ts";
import { assertNotCancelled, indexCancelKey } from "../utils/cancellation.ts";

const log = createLogger("index-worker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_NAME = "indexing";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CLONE_BASE_DIR = process.env.CLONE_DIR || "/tmp/supplyhouse-repos";

/** File extensions we know how to parse. */
const PARSEABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".java",
  ".dart",
  ".ftl",
]);

/** Directories that should always be excluded. */
const ALWAYS_EXCLUDE = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "__pycache__", ".venv", "venv",
  ".gradle", ".mvn", "target", "build",
  "dist", ".next", ".nuxt", "out",
  ".dart_tool", ".flutter-plugins",
  ".idea", ".vscode",
]);

/** Maximum file size to parse (512 KB). */
const MAX_FILE_SIZE = 512 * 1024;

// ---------------------------------------------------------------------------
// Parser registry
// ---------------------------------------------------------------------------

const PARSERS: CodeParser[] = [
  typescriptParser,
  javaParser,
  dartParser,
  ftlParser,
];

function getParserForFile(filePath: string): CodeParser | null {
  const ext = path.extname(filePath).toLowerCase();
  // TypeScript parser also handles .js/.jsx since the regex fallback works.
  if (ext === ".js" || ext === ".jsx") return typescriptParser;
  return PARSERS.find((p) => p.fileExtensions.includes(ext)) ?? null;
}

// ---------------------------------------------------------------------------
// BullMQ Queue + Worker
// ---------------------------------------------------------------------------

/**
 * The BullMQ queue instance. Can be imported to add jobs externally.
 */
export const indexQueue = new Queue(QUEUE_NAME, {
  connection: {
    url: REDIS_URL,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  },
});

/**
 * Start the indexing worker. Call this once at application startup.
 */
export function startIndexWorker(): Worker {
  // Pre-load tree-sitter modules (non-blocking, best-effort).
  Promise.allSettled([
    ensureTsTreeSitter(),
    ensureJavaTreeSitter(),
    ensureDartTreeSitter(),
  ]);

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as IndexJob;
      log.info({ jobId: data.id, repoUrl: data.repoUrl }, "Index job started");
      await processIndexJob(data);
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 2,
      limiter: {
        max: 5,
        duration: 60_000,
      },
    },
  );

  worker.on("completed", async (job) => {
    log.info({ jobId: job?.id }, "Index job completed");
    const tokenKey = (job?.data as IndexJob | undefined)?.tokenKey;
    if (tokenKey) {
      await deleteToken(tokenKey).catch(() => {});
    }
  });

  worker.on("failed", async (job, error) => {
    log.error({ jobId: job?.id, error: error.message }, "Index job failed");
    if (job) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        const tokenKey = (job.data as IndexJob | undefined)?.tokenKey;
        if (tokenKey) {
          await deleteToken(tokenKey).catch(() => {});
        }
      }
    }
  });

  log.info("Index worker started");
  return worker;
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async function processIndexJob(job: IndexJob): Promise<void> {
  const { id: jobId, repoUrl, branch } = job;
  let token: string | undefined;
  const { repoId } = deriveRepoIdFromUrl(repoUrl);
  const cancelKey = indexCancelKey(jobId);
  let cloneDir = "";

  try {
    if (job.tokenKey) {
      token = await fetchToken(job.tokenKey) ?? undefined;
    }
    if (!token) {
      throw new Error("Bitbucket token not available for index job");
    }
    if (!env.VOYAGE_API_KEY) {
      throw new Error("VOYAGE_API_KEY is required to index repositories");
    }
    await assertNotCancelled(cancelKey, "Index job cancelled");
    // ---- Step 1: Clone --------------------------------------------------
    await updateStatus(jobId, "cloning", 5, { repoUrl, branch, repoId });
    await assertNotCancelled(cancelKey, "Index job cancelled");
    cloneDir = await cloneRepo(repoUrl, branch, token);
    await updateStatus(jobId, "cloning", 15);
    await assertNotCancelled(cancelKey, "Index job cancelled");

    // ---- Step 2: Detect framework ---------------------------------------
    await updateStatus(jobId, "detecting-framework", 20, { repoId });
    const detections = await detectFrameworks(cloneDir);
    const overrideFramework = job.framework?.trim();
    const matchedOverride = overrideFramework
      ? detections.find((d) => d.framework === overrideFramework)
      : undefined;
    const primaryFramework =
      overrideFramework && overrideFramework.length > 0
        ? overrideFramework
        : detections[0]?.framework ?? "unknown";
    const excludePatterns = new Set<string>([
      ...ALWAYS_EXCLUDE,
      ...(matchedOverride ? matchedOverride.excludePatterns : detections.flatMap((d) => d.excludePatterns)),
    ]);
    await updateStatus(jobId, "detecting-framework", 25, { framework: primaryFramework, branch, repoUrl, repoId });

    // ---- Full re-index: clear old data ----------------------------------
    if (!job.incremental) {
      await updateStatus(jobId, "parsing", 28);
      await assertNotCancelled(cancelKey, "Index job cancelled");
      await deleteRepoData(repoId);
    }

    // ---- Incremental: delete old data for changed files -----------------
    if (job.incremental && job.changedFiles && job.changedFiles.length > 0) {
      await updateStatus(jobId, "parsing", 28);
      await assertNotCancelled(cancelKey, "Index job cancelled");
      await deleteOldData(repoId, job.changedFiles);
    }

    // ---- Step 3: Parse files --------------------------------------------
    await updateStatus(jobId, "parsing", 30);

    let sourceFiles: string[];

    if (job.incremental && job.changedFiles) {
      // Only parse changed files
      sourceFiles = job.changedFiles
        .map((f) => path.join(cloneDir, f))
        .filter((f) => {
          try {
            const ext = path.extname(f).toLowerCase();
            if (!PARSEABLE_EXTENSIONS.has(ext)) return false;
            const stat = fs.statSync(f);
            return stat.size <= MAX_FILE_SIZE;
          } catch {
            return false;
          }
        });
    } else {
      sourceFiles = collectSourceFiles(cloneDir, excludePatterns);
    }

    const totalFiles = sourceFiles.length;
    log.info({ jobId, totalFiles, framework: primaryFramework, incremental: !!job.incremental }, "Parsing source files");

    const parsedFiles: ParsedFile[] = [];
    let filesProcessed = 0;

    for (const filePath of sourceFiles) {
      const parser = getParserForFile(filePath);
      if (!parser) continue;

      try {
        const code = fs.readFileSync(filePath, "utf-8");
        // Use relative path from clone dir for graph / storage
        const relativePath = path.relative(cloneDir, filePath);
        const parsed = parser.parse(code, relativePath);
        parsedFiles.push(parsed);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn({ jobId, file: filePath, error: msg }, "Failed to parse file");
      }

      filesProcessed++;
      // Update progress every 20 files or at the end
      if (filesProcessed % 20 === 0 || filesProcessed === totalFiles) {
        const parseProgress = 30 + Math.round((filesProcessed / Math.max(totalFiles, 1)) * 25);
        await updateStatus(jobId, "parsing", parseProgress, {
          filesProcessed,
          totalFiles,
        });
        await assertNotCancelled(cancelKey, "Index job cancelled");
      }
    }

    log.info(
      { jobId, parsedFiles: parsedFiles.length, totalFiles },
      "Parsing complete",
    );

    // ---- Step 4: Build graph --------------------------------------------
    await updateStatus(jobId, "building-graph", 60);
    await assertNotCancelled(cancelKey, "Index job cancelled");
    await buildGraph(repoId, parsedFiles);
    await updateStatus(jobId, "building-graph", 75);
    await assertNotCancelled(cancelKey, "Index job cancelled");

    // ---- Step 5: Generate embeddings ------------------------------------
    await updateStatus(jobId, "generating-embeddings", 78);
    await assertNotCancelled(cancelKey, "Index job cancelled");
    const snippets = extractSnippets(parsedFiles);
    const embeddingsStored = await generateAndStoreEmbeddings(repoId, snippets);
    await updateStatus(jobId, "generating-embeddings", 95, {
      functionsIndexed: embeddingsStored,
    });
    await assertNotCancelled(cancelKey, "Index job cancelled");

    // ---- Done -----------------------------------------------------------
    await updateStatus(jobId, "complete", 100, {
      filesProcessed: parsedFiles.length,
      totalFiles,
      functionsIndexed: embeddingsStored,
      framework: primaryFramework,
      repoId,
    });

    log.info(
      {
        jobId,
        framework: primaryFramework,
        files: parsedFiles.length,
        embeddings: embeddingsStored,
        incremental: !!job.incremental,
      },
      "Indexing complete",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ jobId, error: msg }, "Indexing failed");
    await updateStatus(jobId, "failed", 0, { error: msg });
    throw error;
  } finally {
    // Cleanup: remove the cloned repo directory
    if (cloneDir) {
      try {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      } catch {
        log.warn({ jobId, cloneDir }, "Failed to clean up clone directory");
      }
    }
  }
}

/**
 * Clear all graph nodes and vector data for a repo before a full re-index.
 */
async function deleteRepoData(repoId: string): Promise<void> {
  log.info({ repoId }, "Deleting existing data before full re-index");

  try {
    await runCypher(
      "MATCH (n {repoId: $repoId}) DETACH DELETE n",
      { repoId },
    );
  } catch (error) {
    log.warn(
      { repoId, error: error instanceof Error ? error.message : String(error) },
      "Failed to delete old graph data",
    );
  }

  const collection = collectionName(repoId);
  try {
    await qdrantBreaker.execute(() => qdrantClient.deleteCollection(collection));
  } catch (error) {
    log.warn(
      { repoId, collection, error: error instanceof Error ? error.message : String(error) },
      "Failed to delete old vector collection",
    );
  }
}

/**
 * Delete existing graph nodes and vector embeddings for a set of files.
 * Used during incremental re-indexing.
 */
async function deleteOldData(repoId: string, changedFiles: string[]): Promise<void> {
  log.info({ repoId, files: changedFiles.length }, "Deleting old data for incremental re-index");

  // Delete Memgraph nodes for these files
  try {
    await runCypher(
      `MATCH (f:File) WHERE f.repoId = $repoId AND f.path IN $paths DETACH DELETE f`,
      { repoId, paths: changedFiles },
    );
    await runCypher(
      `MATCH (fn:Function) WHERE fn.repoId = $repoId AND fn.file IN $paths DETACH DELETE fn`,
      { repoId, paths: changedFiles },
    );
    await runCypher(
      `MATCH (c:Class) WHERE c.repoId = $repoId AND c.file IN $paths DETACH DELETE c`,
      { repoId, paths: changedFiles },
    );
  } catch (error) {
    log.warn({ repoId, error: error instanceof Error ? error.message : String(error) }, "Failed to delete old Memgraph data");
  }

  // Delete Qdrant points for these files
  try {
    const collection = collectionName(repoId);
    await qdrantBreaker.execute(() =>
      qdrantClient.delete(collection, {
        filter: {
          must: [
            {
              key: "repoId",
              match: { value: repoId },
            },
            {
              key: "file",
              match: { any: changedFiles },
            },
          ],
        },
      }),
    );
  } catch (error) {
    log.warn({ repoId, error: error instanceof Error ? error.message : String(error) }, "Failed to delete old Qdrant data");
  }
}

// ---------------------------------------------------------------------------
// Git clone
// ---------------------------------------------------------------------------

async function cloneRepo(
  repoUrl: string,
  branch: string,
  token: string,
): Promise<string> {
  // Ensure base directory exists
  fs.mkdirSync(CLONE_BASE_DIR, { recursive: true });

  const cloneDir = path.join(CLONE_BASE_DIR, `repo_${randomUUID()}`);

  // Inject token into URL for HTTPS authentication
  let authUrl = repoUrl;
  if (token && repoUrl.startsWith("https://")) {
    const url = new URL(repoUrl);
    url.username = "x-token-auth";
    url.password = token;
    authUrl = url.toString();
  }

  log.info({ repoUrl, branch, cloneDir }, "Cloning repository");

  const proc = Bun.spawn(
    ["git", "clone", "--depth", "1", "--branch", branch, authUrl, cloneDir],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // Sanitize: remove the token from error messages
    const sanitized = stderr.replace(
      /x-token-auth:[^@]+@/g,
      "x-token-auth:***@",
    );
    throw new Error(`git clone failed (exit ${exitCode}): ${sanitized}`);
  }

  return cloneDir;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * Recursively walk the directory tree and collect files that match parseable
 * extensions, skipping excluded directories and files exceeding the size limit.
 */
function collectSourceFiles(
  dir: string,
  excludePatterns: Set<string>,
): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (excludePatterns.has(entry.name) || ALWAYS_EXCLUDE.has(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!PARSEABLE_EXTENSIONS.has(ext)) continue;

        // Skip large files
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// Snippet extraction (for embeddings)
// ---------------------------------------------------------------------------

/**
 * Convert parsed files into CodeSnippet array suitable for embedding.
 * Each function and class method becomes one snippet.
 */
function extractSnippets(files: ParsedFile[]): CodeSnippet[] {
  const snippets: CodeSnippet[] = [];

  for (const file of files) {
    // Top-level functions
    for (const fn of file.functions) {
      snippets.push({
        name: fn.name,
        code: fn.body || `function ${fn.name}${fn.params}`,
        file: file.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
    }

    // Class methods
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        snippets.push({
          name: `${cls.name}.${method.name}`,
          code: method.body || `${method.name}${method.params}`,
          file: file.filePath,
          startLine: method.startLine,
          endLine: method.endLine,
        });
      }

      // If the class has no methods but has properties, embed the class itself
      if (cls.methods.length === 0) {
        snippets.push({
          name: cls.name,
          code: `class ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ""}`,
          file: file.filePath,
          startLine: cls.startLine,
          endLine: cls.endLine,
        });
      }
    }
  }

  return snippets;
}

// ---------------------------------------------------------------------------
// Status management
// ---------------------------------------------------------------------------

/**
 * Update the index job status in Redis and publish a progress event.
 */
async function updateStatus(
  jobId: string,
  phase: IndexPhase,
  percentage: number,
  extra?: Partial<
    Pick<
      IndexStatus,
      "framework" | "filesProcessed" | "totalFiles" | "functionsIndexed" | "error" | "repoUrl" | "branch" | "repoId"
    >
  >,
): Promise<void> {
  const key = `index:${jobId}`;

  // Read current status to merge with updates
  let current: Partial<IndexStatus> = {};
  try {
    const raw = await redis.get(key);
    if (raw) current = JSON.parse(raw);
  } catch {
    // Ignore parse errors
  }

  if (current.phase === "complete" || current.phase === "failed") {
    return;
  }

  const status: IndexStatus = {
    id: jobId,
    phase,
    percentage,
    repoId: extra?.repoId ?? current.repoId,
    repoUrl: extra?.repoUrl ?? current.repoUrl,
    branch: extra?.branch ?? current.branch,
    framework: extra?.framework ?? current.framework,
    filesProcessed: extra?.filesProcessed ?? current.filesProcessed ?? 0,
    totalFiles: extra?.totalFiles ?? current.totalFiles ?? 0,
    functionsIndexed: extra?.functionsIndexed ?? current.functionsIndexed ?? 0,
    error: extra?.error,
    startedAt: (current.startedAt as string | undefined) ?? new Date().toISOString(),
    completedAt: phase === "complete" || phase === "failed" ? new Date().toISOString() : undefined,
  };

  await redis.set(key, JSON.stringify(status));

  // Publish progress event via pub/sub for WebSocket clients
  await publish(`index:progress:${jobId}`, {
    jobId,
    phase,
    percentage,
    ...extra,
  });
}
