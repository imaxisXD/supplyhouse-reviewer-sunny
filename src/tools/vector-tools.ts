import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { qdrantClient } from "../db/qdrant.ts";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "./repo-context.ts";
import { withRetry } from "../utils/retry.ts";
import { qdrantBreaker, voyageBreaker } from "../services/breakers.ts";
import { collectionName } from "../indexing/embedding-generator.ts";
import { env } from "../config/env.ts";

const log = createLogger("tools:vector");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calls the Voyage AI API to embed a code snippet.
 * Returns a 1024-dimensional vector.
 */
async function embedCode(code: string): Promise<number[]> {
  const apiKey = env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is required to search similar code");
  }

  const response = await voyageBreaker.execute(() =>
    withRetry(
      () =>
        fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "voyage-code-3",
            input: [code],
            input_type: "query",
          }),
        }),
      { maxRetries: 3, baseDelay: 1000 },
    ),
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Voyage AI embedding failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    data: { embedding: number[] }[];
  };

  if (!data.data?.[0]?.embedding) {
    throw new Error("Voyage AI returned empty embedding");
  }

  return data.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Shared output schemas
// ---------------------------------------------------------------------------

const SimilarMatch = z.object({
  functionName: z.string(),
  filePath: z.string(),
  code: z.string(),
  similarity: z.number(),
  startLine: z.number(),
  endLine: z.number(),
});

const DuplicateMatch = z.object({
  newFunction: z.object({
    name: z.string(),
    file: z.string(),
    line: z.number(),
  }),
  existingFunction: z.object({
    name: z.string(),
    file: z.string(),
    line: z.number(),
  }),
  similarity: z.number(),
});

// ---------------------------------------------------------------------------
// search_similar
// ---------------------------------------------------------------------------

export const searchSimilarTool = createTool({
  id: "search_similar",
  description:
    "Find semantically similar code in the indexed codebase by embedding the input " +
    "code with Voyage AI and querying Qdrant for nearest neighbours. Returns matches " +
    "above the given similarity threshold.",
  inputSchema: z.object({
    code: z.string().describe("The code snippet to find similar matches for"),
    repoId: z.string().optional().describe("Repository identifier (defaults to active repo context)"),
    topK: z.number().default(5).describe("Maximum number of results to return"),
    threshold: z.number().default(0.85).describe("Minimum similarity score (0-1)"),
    excludeFile: z.string().optional().describe("File path to exclude from results"),
  }),
  outputSchema: z.object({
    matches: z.array(SimilarMatch),
  }),
  execute: async (input) => {
    const { code, topK, threshold, excludeFile } = input;
    const repoId = input.repoId ?? getRepoContext()?.repoId;
    log.debug({ repoId, topK, threshold, excludeFile }, "Searching for similar code");

    try {
      if (!repoId) {
        log.warn({ topK, threshold }, "search_similar missing repoId");
        return { matches: [] };
      }
      const vector = await embedCode(code);

      const filter: Record<string, unknown> = {
        must: [{ key: "repoId", match: { value: repoId } }],
      };

      if (excludeFile) {
        (filter as Record<string, unknown[]>).must_not = [
          { key: "file", match: { value: excludeFile } },
        ];
      }

      const results = await qdrantBreaker.execute(() =>
        qdrantClient.search(collectionName(repoId), {
          vector,
          limit: topK,
          score_threshold: threshold,
          filter: filter as never,
          with_payload: true,
        }),
      );

      const matches = results.map((r) => {
        const payload = r.payload as Record<string, unknown>;
        return {
          functionName: (payload.name as string) ?? "",
          filePath: (payload.file as string) ?? "",
          code: (payload.codePreview as string) ?? "",
          similarity: r.score,
          startLine: Number(payload.startLine ?? 0),
          endLine: Number(payload.endLine ?? 0),
        };
      });

      log.debug({ matchCount: matches.length }, "Similar code search complete");
      return { matches };
    } catch (error) {
      log.error({ error }, "Failed to search similar code");
      return { matches: [] };
    }
  },
});

// ---------------------------------------------------------------------------
// find_duplicates
// ---------------------------------------------------------------------------

export const findDuplicatesTool = createTool({
  id: "find_duplicates",
  description:
    "Given an array of new functions from a PR, find existing functions in the codebase " +
    "that are duplicates (above the given similarity threshold). Wraps the search_similar " +
    "logic for batch processing.",
  inputSchema: z.object({
    functions: z
      .array(
        z.object({
          name: z.string(),
          code: z.string(),
          file: z.string(),
          line: z.number(),
        }),
      )
      .describe("New functions from the PR to check for duplicates"),
    repoId: z.string().optional().describe("Repository identifier (defaults to active repo context)"),
    threshold: z.number().default(0.9).describe("Minimum similarity to consider a duplicate"),
  }),
  outputSchema: z.object({
    duplicates: z.array(DuplicateMatch),
  }),
  execute: async (input) => {
    const { functions, threshold } = input;
    const repoId = input.repoId ?? getRepoContext()?.repoId;
    log.debug({ functionCount: functions.length, repoId, threshold }, "Finding duplicates");

    const duplicates: z.infer<typeof DuplicateMatch>[] = [];

    for (const fn of functions) {
      try {
        if (!repoId) {
          log.warn({ functionName: fn.name }, "find_duplicates missing repoId");
          break;
        }
        const vector = await embedCode(fn.code);

        const results = await qdrantBreaker.execute(() =>
          qdrantClient.search(collectionName(repoId), {
            vector,
            limit: 5,
            score_threshold: threshold,
            filter: {
              must: [{ key: "repoId", match: { value: repoId } }],
              must_not: [{ key: "file", match: { value: fn.file } }],
            } as never,
            with_payload: true,
          }),
        );

        for (const r of results) {
          const payload = r.payload as Record<string, unknown>;
          duplicates.push({
            newFunction: {
              name: fn.name,
              file: fn.file,
              line: fn.line,
            },
            existingFunction: {
              name: (payload.name as string) ?? "",
              file: (payload.file as string) ?? "",
              line: Number(payload.startLine ?? 0),
            },
            similarity: r.score,
          });
        }
      } catch (error) {
        log.warn({ error, functionName: fn.name }, "Failed to check duplicates for function");
      }
    }

    log.debug({ duplicateCount: duplicates.length }, "Duplicate search complete");
    return { duplicates };
  },
});
