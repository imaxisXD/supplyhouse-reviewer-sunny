/**
 * Embedding generator: produces code embeddings via Voyage AI and stores them
 * in Qdrant.
 *
 * Model: voyage-code-3 (1024-dimensional vectors, optimised for code).
 * API:   https://api.voyageai.com/v1/embeddings
 */

import { qdrantClient, ensureCollection } from "../db/qdrant.ts";
import { env } from "../config/env.ts";
import { createLogger } from "../config/logger.ts";
import { randomUUID } from "crypto";
import { qdrantBreaker, voyageBreaker } from "../services/breakers.ts";

const log = createLogger("embedding-generator");

/** Voyage AI endpoint. */
const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

/** Model identifier. */
const VOYAGE_MODEL = "voyage-code-3";

/** Dimensionality of the output vectors. */
const VECTOR_SIZE = 1024;

/** Max estimated tokens per Voyage API call (conservative margin under 120K limit). */
const VOYAGE_MAX_TOKENS_PER_BATCH = 60_000;

/** Max inputs per Voyage API call (API allows 1000, we cap lower to limit payload size). */
const VOYAGE_MAX_INPUTS_PER_BATCH = 200;

/** Number of concurrent Voyage API calls. */
const DEFAULT_CONCURRENCY = 3;

/** Max retries on 429 rate limit. */
const MAX_RETRIES = 3;

/** Qdrant collection name template. One collection per repo. */
export function collectionName(repoId: string): string {
  // Qdrant collection names must be alphanumeric + underscores / hyphens.
  return `repo_${repoId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// ---------------------------------------------------------------------------
// Collection existence cache
// ---------------------------------------------------------------------------

const _collectionExistsCache = new Map<string, { exists: boolean; checkedAt: number }>();
const COLLECTION_CHECK_TTL_MS = 60_000;

async function collectionExists(name: string): Promise<boolean> {
  const cached = _collectionExistsCache.get(name);
  if (cached && Date.now() - cached.checkedAt < COLLECTION_CHECK_TTL_MS) {
    return cached.exists;
  }
  try {
    const { collections } = await qdrantClient.getCollections();
    const exists = collections.some((c) => c.name === name);
    _collectionExistsCache.set(name, { exists, checkedAt: Date.now() });
    return exists;
  } catch {
    return false;
  }
}

export function invalidateCollectionCache(repoId: string): void {
  _collectionExistsCache.delete(collectionName(repoId));
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodeSnippet {
  name: string;
  code: string;
  file: string;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  // Code typically has ~3 chars per token (more conservative than prose's ~4)
  // due to symbols, keywords, and special characters
  return Math.ceil(text.length / 3);
}

// ---------------------------------------------------------------------------
// Voyage AI embedding call (with 429 retry)
// ---------------------------------------------------------------------------

/**
 * Call the Voyage AI REST API to produce embeddings for an array of strings.
 * Retries automatically on 429 rate-limit responses with exponential backoff.
 *
 * @param texts  Array of code strings.
 * @returns Array of 1024-dimensional float arrays, one per input text.
 */
async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is required to generate embeddings");
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await voyageBreaker.execute(() =>
      fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: VOYAGE_MODEL,
          input: texts,
          input_type: "document",
        }),
      }),
    );

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error("Voyage AI rate limited after max retries");
      }
      const retryAfter = response.headers.get("retry-after");
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * (attempt + 1);
      log.warn({ attempt, delayMs }, "Voyage rate limited, backing off");
      await sleep(delayMs);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Voyage AI returned ${response.status}: ${body}`);
      // Mark token limit errors so they can be handled by batch splitting
      if (response.status === 400 && body.includes("max allowed tokens")) {
        (error as Error & { isTokenLimitError: boolean }).isTokenLimitError = true;
      }
      throw error;
    }

    const json = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to guarantee order matches input order.
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  throw new Error("Unreachable: exceeded max retries");
}

// ---------------------------------------------------------------------------
// Qdrant upsert
// ---------------------------------------------------------------------------

/**
 * Upsert points into the Qdrant collection for this repo.
 * Uses wait: false for non-blocking writes — Qdrant guarantees eventual
 * consistency and all upserts will be processed by the time the full
 * embedding pipeline completes.
 */
async function upsertPoints(
  collection: string,
  points: {
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }[],
): Promise<void> {
  if (points.length === 0) return;

  await qdrantBreaker.execute(() =>
    qdrantClient.upsert(collection, {
      wait: false,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Batch building
// ---------------------------------------------------------------------------

interface SnippetBatch {
  index: number;
  snippets: CodeSnippet[];
}

function snippetToText(s: CodeSnippet): string {
  const truncatedCode = s.code.length > 8000
    ? s.code.slice(0, 8000) + "\n// ... truncated"
    : s.code;
  return `// ${s.file}:${s.startLine}\n// ${s.name}\n${truncatedCode}`;
}

function buildBatches(snippets: CodeSnippet[]): SnippetBatch[] {
  const batches: SnippetBatch[] = [];
  let currentBatch: CodeSnippet[] = [];
  let currentTokens = 0;
  let batchIndex = 1;

  for (const snippet of snippets) {
    const text = snippetToText(snippet);
    const tokens = estimateTokens(text);

    if (
      currentBatch.length > 0 &&
      (currentTokens + tokens > VOYAGE_MAX_TOKENS_PER_BATCH ||
        currentBatch.length >= VOYAGE_MAX_INPUTS_PER_BATCH)
    ) {
      batches.push({ index: batchIndex++, snippets: currentBatch });
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(snippet);
    currentTokens += tokens;
  }

  if (currentBatch.length > 0) {
    batches.push({ index: batchIndex, snippets: currentBatch });
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate code embeddings via Voyage AI and store them in Qdrant.
 * Uses dynamic batching by token count, concurrent API calls, and
 * non-blocking Qdrant upserts for high throughput.
 *
 * @param repoId      Unique identifier for the repository.
 * @param snippets    Array of code snippets to embed.
 * @param concurrency Number of concurrent Voyage API calls (default 3).
 * @returns The number of embeddings stored.
 */
export async function generateAndStoreEmbeddings(
  repoId: string,
  snippets: CodeSnippet[],
  concurrency = DEFAULT_CONCURRENCY,
): Promise<number> {
  if (snippets.length === 0) {
    log.info({ repoId }, "No code snippets to embed");
    return 0;
  }

  log.info(
    { repoId, snippetCount: snippets.length, concurrency },
    "Generating code embeddings",
  );

  // Ensure the Qdrant collection exists.
  const collection = collectionName(repoId);
  await ensureCollection(collection, VECTOR_SIZE);

  // Build batches dynamically by token count
  const batches = buildBatches(snippets);

  log.info(
    { repoId, batchCount: batches.length, snippetCount: snippets.length },
    "Batches created for embedding",
  );

  const results = new Array<number>(batches.length).fill(0);
  const batchErrors: Error[] = [];

  async function processBatch(batchIdx: number): Promise<void> {
    const batch = batches[batchIdx]!;
    const stored = await processSnippets(batch.snippets, batch.index);
    results[batchIdx] = stored;
  }

  async function processSnippets(snippets: CodeSnippet[], batchIndex: number): Promise<number> {
    const texts = snippets.map(snippetToText);

    let embeddings: number[][];
    try {
      embeddings = await fetchEmbeddings(texts);
    } catch (error) {
      // If token limit exceeded, split the batch and retry
      if (
        error instanceof Error &&
        (error as Error & { isTokenLimitError?: boolean }).isTokenLimitError &&
        snippets.length > 1
      ) {
        log.warn(
          { repoId, batch: batchIndex, snippetCount: snippets.length },
          "Token limit exceeded, splitting batch",
        );
        const mid = Math.floor(snippets.length / 2);
        const firstHalf = await processSnippets(snippets.slice(0, mid), batchIndex);
        const secondHalf = await processSnippets(snippets.slice(mid), batchIndex);
        return firstHalf + secondHalf;
      }
      throw error;
    }

    const points = snippets
      .map((snippet, idx) => ({
        id: randomUUID(),
        vector: embeddings[idx] as number[] | undefined,
        payload: {
          repoId,
          name: snippet.name,
          file: snippet.file,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          codePreview: snippet.code.slice(0, 2000),
        },
      }))
      .filter(
        (p): p is typeof p & { vector: number[] } => p.vector !== undefined,
      );

    await upsertPoints(collection, points);

    log.debug(
      { repoId, batch: batchIndex, stored: points.length },
      "Batch embedded and stored",
    );

    return points.length;
  }

  // Process batches with bounded concurrency using a shared queue
  const queue = batches.map((_, i) => i);
  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
    async () => {
      while (queue.length > 0) {
        const idx = queue.shift();
        if (idx === undefined) break;
        try {
          await processBatch(idx);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log.error(
            { repoId, batch: batches[idx]!.index, error: msg },
            "Failed to embed batch",
          );
          batchErrors.push(
            error instanceof Error ? error : new Error(msg),
          );
          // Drain the queue so other workers stop picking up work
          queue.length = 0;
        }
      }
    },
  );

  await Promise.all(workers);

  if (batchErrors.length > 0) {
    throw batchErrors[0];
  }

  const totalStored = results.reduce((a, b) => a + b, 0);

  log.info(
    { repoId, totalStored, totalSnippets: snippets.length },
    "Embedding generation complete",
  );

  return totalStored;
}

/**
 * Search for similar code snippets in Qdrant.
 *
 * @param repoId  Repository identifier.
 * @param query   The query code or text to search for.
 * @param limit   Maximum number of results.
 * @returns Array of search results with payload and score.
 */
export async function searchSimilarCode(
  repoId: string,
  query: string,
  limit = 10,
): Promise<
  {
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    codePreview: string;
    score: number;
  }[]
> {
  const collection = collectionName(repoId);

  // Bail early if the collection doesn't exist (avoids wasted Voyage API call)
  if (!(await collectionExists(collection))) {
    return [];
  }

  // Embed the query
  const [queryVector] = await fetchEmbeddings([query]);
  if (!queryVector) {
    throw new Error("Failed to generate query embedding");
  }

  const results = await qdrantBreaker.execute(() =>
    qdrantClient.search(collection, {
      vector: queryVector,
      limit,
      with_payload: true,
    }),
  );

  return results.map((r) => ({
    name: (r.payload?.name as string) ?? "",
    file: (r.payload?.file as string) ?? "",
    startLine: (r.payload?.startLine as number) ?? 0,
    endLine: (r.payload?.endLine as number) ?? 0,
    codePreview: (r.payload?.codePreview as string) ?? "",
    score: r.score,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
