import type { DiffFile } from "../types/bitbucket.ts";
import { runCypher } from "../db/memgraph.ts";
import { searchSimilarCode } from "../indexing/embedding-generator.ts";
import { createLogger } from "../config/logger.ts";
import { readFile } from "fs/promises";
import { join } from "path";

const log = createLogger("context-builder");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Caller {
  function: string;
  file: string;
  line: number;
}

export interface Callee {
  function: string;
  file: string;
  line: number;
}

export interface SimilarCode {
  function: string;
  file: string;
  similarity: number;
  code: string;
}

export interface Usage {
  file: string;
  line: number;
  content: string;
}

export interface ContextPackage {
  file: string;
  diff: string;
  fullFunctions: string[];
  callers: Caller[];
  callees: Callee[];
  similarCode: SimilarCode[];
  usages: Usage[];
}

export interface BuildContextOptions {
  skipGraph?: boolean;
  skipVectors?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many similar code results to return from Qdrant. */
const SIMILAR_CODE_LIMIT = 5;

/** Minimum similarity score to include a result. */
const SIMILARITY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Build rich context packages for every changed file in a pull request.
 *
 * For each DiffFile the builder:
 *   1. Reads the full file to expand diffs into complete function bodies.
 *   2. Queries Memgraph for callers and callees of changed functions.
 *   3. Queries Qdrant for semantically similar code.
 *   4. Performs a text search for usages of changed identifiers.
 */
export async function buildContext(
  repoId: string,
  diffFiles: DiffFile[],
  repoPath: string,
  onFileStart?: (filePath: string, index: number, total: number) => void | Promise<void>,
  options?: BuildContextOptions,
): Promise<ContextPackage[]> {
  const packages: ContextPackage[] = [];

  for (let i = 0; i < diffFiles.length; i++) {
    const diffFile = diffFiles[i]!;
    if (onFileStart) {
      await onFileStart(diffFile.path, i + 1, diffFiles.length);
    }
    log.debug({ file: diffFile.path }, "Building context for file");

    try {
      const ctx = await buildFileContext(repoId, diffFile, repoPath, options);
      packages.push(ctx);
    } catch (error) {
      log.error(
        { file: diffFile.path, error: error instanceof Error ? error.message : String(error) },
        "Failed to build context for file, using minimal context",
      );

      // Fall back to a minimal context package so the review can proceed
      packages.push({
        file: diffFile.path,
        diff: diffFile.diff,
        fullFunctions: [],
        callers: [],
        callees: [],
        similarCode: [],
        usages: [],
      });
    }
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Per-file context building
// ---------------------------------------------------------------------------

async function buildFileContext(
  repoId: string,
  diffFile: DiffFile,
  repoPath: string,
  options?: BuildContextOptions,
): Promise<ContextPackage> {
  // 1. Expand diff into full function bodies
  const fullFunctions = await expandToFullFunctions(diffFile, repoPath);

  // 2. Extract changed function names from the diff
  const changedFunctions = extractChangedFunctionNames(diffFile.diff);

  // 3. Query graph and vector DB in parallel
  const [callers, callees, similarCode, usages] = await Promise.all([
    options?.skipGraph ? Promise.resolve([]) : findCallers(repoId, changedFunctions),
    options?.skipGraph ? Promise.resolve([]) : findCallees(repoId, changedFunctions),
    options?.skipVectors ? Promise.resolve([]) : findSimilarCode(repoId, diffFile.path, fullFunctions),
    options?.skipGraph ? Promise.resolve([]) : findUsages(repoId, changedFunctions),
  ]);

  return {
    file: diffFile.path,
    diff: diffFile.diff,
    fullFunctions,
    callers,
    callees,
    similarCode,
    usages,
  };
}

// ---------------------------------------------------------------------------
// 1. Expand diff to full function bodies
// ---------------------------------------------------------------------------

/**
 * Read the full file and attempt to extract complete function bodies for
 * every function that was touched in the diff.
 */
async function expandToFullFunctions(
  diffFile: DiffFile,
  repoPath: string,
): Promise<string[]> {
  // For deleted files there is no new version to read
  if (diffFile.status === "deleted") return [];

  const filePath = join(repoPath, diffFile.path);
  let fileContent: string;

  try {
    fileContent = await readFile(filePath, "utf-8");
  } catch {
    log.debug({ path: filePath }, "Could not read file for function expansion");
    return [];
  }

  const fileLines = fileContent.split("\n");

  // Extract line numbers that were changed (added or modified)
  const changedLineNumbers = extractChangedLineNumbers(diffFile.diff);

  // Find function boundaries that contain changed lines
  const functionBodies: string[] = [];
  const functionRanges = detectFunctionRanges(fileLines);

  for (const range of functionRanges) {
    const overlaps = changedLineNumbers.some(
      (lineNum) => lineNum >= range.start && lineNum <= range.end,
    );
    if (overlaps) {
      const body = fileLines.slice(range.start - 1, range.end).join("\n");
      functionBodies.push(body);
    }
  }

  return functionBodies;
}

/**
 * Extract the new-file line numbers that were added or modified from the raw diff text.
 */
function extractChangedLineNumbers(diff: string): number[] {
  const lines = diff.split("\n");
  const lineNumbers: number[] = [];
  let currentNewLine = 0;

  const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

  for (const line of lines) {
    const hunkMatch = line.match(hunkRegex);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1]!, 10);
      continue;
    }

    if (currentNewLine === 0) continue;

    if (line.startsWith("+")) {
      lineNumbers.push(currentNewLine);
      currentNewLine++;
    } else if (line.startsWith("-")) {
      // Deleted line -- new-file line counter does not advance
    } else {
      // Context line
      currentNewLine++;
    }
  }

  return lineNumbers;
}

interface FunctionRange {
  name: string;
  start: number; // 1-indexed
  end: number;   // 1-indexed
}

/**
 * Heuristic function-range detection.
 *
 * Supports common patterns:
 *   - `function name(` / `async function name(`
 *   - `name(` / `name = (` / `name = async (`  at the start of a line
 *   - `def name(` (Python)
 *   - `fn name(` (Rust)
 *   - Method definitions in classes
 *
 * Uses brace/indentation counting to find the end of each function.
 */
function detectFunctionRanges(lines: string[]): FunctionRange[] {
  const ranges: FunctionRange[] = [];

  // Regex patterns for function declarations
  const functionPatterns = [
    // JS/TS: function name(, async function name(, export function name(
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    // JS/TS: const name = (...) =>, const name = async (...) =>
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    // JS/TS: name(...) { -- method in class
    /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w[^{]*)?\{/,
    // Python: def name(
    /^(?:\s*)def\s+(\w+)\s*\(/,
    // Rust: fn name(, pub fn name(
    /(?:pub\s+)?fn\s+(\w+)\s*\(/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let funcName: string | null = null;

    for (const pattern of functionPatterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        funcName = match[1];
        break;
      }
    }

    if (!funcName) continue;

    // Find end of function using brace counting
    const end = findFunctionEnd(lines, i);

    ranges.push({
      name: funcName,
      start: i + 1, // 1-indexed
      end: end + 1,
    });
  }

  return ranges;
}

/**
 * Starting from `startIdx`, count opening and closing braces to find
 * where the function body ends. Falls back to a maximum of 200 lines
 * if brace matching fails (e.g. indentation-based languages).
 */
function findFunctionEnd(lines: string[], startIdx: number): number {
  let braceDepth = 0;
  let foundOpen = false;
  const maxLines = Math.min(startIdx + 200, lines.length);

  for (let i = startIdx; i < maxLines; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{") {
        braceDepth++;
        foundOpen = true;
      } else if (ch === "}") {
        braceDepth--;
      }
    }

    if (foundOpen && braceDepth <= 0) {
      return i;
    }
  }

  // Fallback: return a reasonable range
  return Math.min(startIdx + 50, lines.length - 1);
}

// ---------------------------------------------------------------------------
// 2. Extract changed function names from diff
// ---------------------------------------------------------------------------

/**
 * Extract function names that appear in added or modified lines of the diff.
 */
function extractChangedFunctionNames(diff: string): string[] {
  const names = new Set<string>();
  const lines = diff.split("\n");

  // Patterns that capture a function name from a diff line
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    /^\+?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
    /^(?:\+?\s*)def\s+(\w+)/,
    /(?:pub\s+)?fn\s+(\w+)/,
  ];

  // Also extract from @@ hunk headers which often contain the function context
  const hunkFuncRegex = /^@@[^@]+@@\s*(?:.*\s)?(?:function|def|fn|async)\s+(\w+)/;

  for (const line of lines) {
    // Only look at added lines and hunk headers
    if (!line.startsWith("+") && !line.startsWith("@@")) continue;

    const hunkMatch = line.match(hunkFuncRegex);
    if (hunkMatch && hunkMatch[1]) {
      names.add(hunkMatch[1]);
      continue;
    }

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        names.add(match[1]);
        break;
      }
    }
  }

  return Array.from(names);
}

// ---------------------------------------------------------------------------
// 3. Memgraph queries: callers and callees
// ---------------------------------------------------------------------------

/**
 * Find all functions that call the given changed functions.
 */
async function findCallers(
  repoId: string,
  functionNames: string[],
): Promise<Caller[]> {
  if (functionNames.length === 0) return [];

  const callers: Caller[] = [];

  for (const name of functionNames) {
    try {
      const records = await runCypher(
        `MATCH (caller:Function)-[:CALLS]->(target:Function {name: $name})
         WHERE caller.repoId = $repoId
         RETURN caller.name AS name, caller.file AS file, caller.startLine AS line`,
        { name, repoId },
      );

      for (const record of records) {
        callers.push({
          function: record.get("name") as string,
          file: record.get("file") as string,
          line: record.get("line") as number,
        });
      }
    } catch (error) {
      log.warn(
        { function: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to query callers from Memgraph",
      );
    }
  }

  return callers;
}

/**
 * Find all functions that the changed functions call.
 */
async function findCallees(
  repoId: string,
  functionNames: string[],
): Promise<Callee[]> {
  if (functionNames.length === 0) return [];

  const callees: Callee[] = [];

  for (const name of functionNames) {
    try {
      const records = await runCypher(
        `MATCH (source:Function {name: $name})-[:CALLS]->(callee:Function)
         WHERE source.repoId = $repoId
         RETURN callee.name AS name, callee.file AS file, callee.startLine AS line`,
        { name, repoId },
      );

      for (const record of records) {
        callees.push({
          function: record.get("name") as string,
          file: record.get("file") as string,
          line: record.get("line") as number,
        });
      }
    } catch (error) {
      log.warn(
        { function: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to query callees from Memgraph",
      );
    }
  }

  return callees;
}

// ---------------------------------------------------------------------------
// 4. Qdrant: similar code search
// ---------------------------------------------------------------------------

/**
 * Search for semantically similar code in the Qdrant vector database.
 *
 */
async function findSimilarCode(
  repoId: string,
  filePath: string,
  functionBodies: string[],
): Promise<SimilarCode[]> {
  if (functionBodies.length === 0) return [];

  const results: SimilarCode[] = [];

  for (const body of functionBodies) {
    try {
      const searchResult = await searchSimilarCode(repoId, body, SIMILAR_CODE_LIMIT);

      for (const hit of searchResult) {
        if (hit.score < SIMILARITY_THRESHOLD) continue;
        if (hit.file === filePath) continue;

        results.push({
          function: hit.name ?? "unknown",
          file: hit.file ?? "unknown",
          similarity: hit.score,
          code: hit.codePreview ?? "",
        });
      }
    } catch (error) {
      log.warn(
        { file: filePath, error: error instanceof Error ? error.message : String(error) },
        "Failed to search similar code in Qdrant",
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 5. Usage search
// ---------------------------------------------------------------------------

/**
 * Search for usages of changed function names across the codebase using
 * Memgraph's indexed data. Falls back to an empty array on error.
 */
async function findUsages(
  repoId: string,
  functionNames: string[],
): Promise<Usage[]> {
  if (functionNames.length === 0) return [];

  const usages: Usage[] = [];

  for (const name of functionNames) {
    try {
      const records = await runCypher(
        `MATCH (f:File)-[:CONTAINS]->(fn:Function)
         WHERE fn.repoId = $repoId AND fn.name = $name
         RETURN f.path AS file, fn.startLine AS line, fn.name AS content`,
        { name, repoId },
      );

      for (const record of records) {
        usages.push({
          file: record.get("file") as string,
          line: record.get("line") as number,
          content: `Usage of ${record.get("content") as string}`,
        });
      }
    } catch (error) {
      log.warn(
        { function: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to search usages",
      );
    }
  }

  return usages;
}
