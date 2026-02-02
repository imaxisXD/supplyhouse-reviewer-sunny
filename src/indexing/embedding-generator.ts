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

/** Maximum texts per single Voyage API call. */
const VOYAGE_BATCH_SIZE = 50;

/** Delay between batches (ms) to avoid rate limits. */
const BATCH_DELAY_MS = 300;

/** Qdrant collection name template. One collection per repo. */
export function collectionName(repoId: string): string {
  // Qdrant collection names must be alphanumeric + underscores / hyphens.
  return `repo_${repoId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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
// Voyage AI embedding call
// ---------------------------------------------------------------------------

/**
 * Call the Voyage AI REST API to produce embeddings for an array of strings.
 *
 * @param texts  Array of code strings (max length enforced by caller).
 * @returns Array of 1024-dimensional float arrays, one per input text.
 */
async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is required to generate embeddings");
  }

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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Voyage AI returned ${response.status}: ${body}`,
    );
  }

  const json = (await response.json()) as {
    data: { embedding: number[]; index: number }[];
  };

  // Sort by index to guarantee order matches input order.
  const sorted = json.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Qdrant upsert
// ---------------------------------------------------------------------------

/**
 * Upsert points into the Qdrant collection for this repo.
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
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate code embeddings via Voyage AI and store them in Qdrant.
 *
 * @param repoId    Unique identifier for the repository.
 * @param snippets  Array of code snippets to embed.
 * @returns The number of embeddings stored.
 */
export async function generateAndStoreEmbeddings(
  repoId: string,
  snippets: CodeSnippet[],
): Promise<number> {
  if (snippets.length === 0) {
    log.info({ repoId }, "No code snippets to embed");
    return 0;
  }

  log.info(
    { repoId, snippetCount: snippets.length },
    "Generating code embeddings",
  );

  // Ensure the Qdrant collection exists.
  const collection = collectionName(repoId);
  await ensureCollection(collection, VECTOR_SIZE);

  let totalStored = 0;

  // Process in batches of VOYAGE_BATCH_SIZE
  for (let i = 0; i < snippets.length; i += VOYAGE_BATCH_SIZE) {
    const batch = snippets.slice(i, i + VOYAGE_BATCH_SIZE);

    // Prepare input texts: combine function name + code for better semantic signal.
    const texts = batch.map((s) => {
      // Truncate very long code to avoid exceeding Voyage token limits.
      const truncatedCode = s.code.length > 8000
        ? s.code.slice(0, 8000) + "\n// ... truncated"
        : s.code;
      return `// ${s.file}:${s.startLine}\n// ${s.name}\n${truncatedCode}`;
    });

    try {
      const embeddings = await fetchEmbeddings(texts);

      // Build Qdrant points
      const points = batch.map((snippet, idx) => ({
        id: randomUUID(),
        vector: embeddings[idx] as number[] | undefined,
        payload: {
          repoId,
          name: snippet.name,
          file: snippet.file,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          // Store a truncated version of the code for retrieval context.
          codePreview: snippet.code.slice(0, 2000),
        },
      })).filter((p): p is typeof p & { vector: number[] } => p.vector !== undefined);

      await upsertPoints(collection, points);
      totalStored += points.length;

      log.debug(
        {
          repoId,
          batch: Math.floor(i / VOYAGE_BATCH_SIZE) + 1,
          stored: points.length,
        },
        "Batch embedded and stored",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(
        { repoId, batchStart: i, error: msg },
        "Failed to embed batch",
      );
      throw error;
    }

    // Rate-limit delay between batches
    if (i + VOYAGE_BATCH_SIZE < snippets.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

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
