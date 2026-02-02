/**
 * Large PR handling utilities.
 *
 * When a PR has many changed files, we prioritize and batch them to stay
 * within token budgets and avoid timeouts.
 */

import type { DiffFile } from "../types/bitbucket.ts";
import { calculateFilePriority } from "../utils/priority.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("large-pr");

/** Maximum files to fully analyze. Files beyond this are summarized only. */
const MAX_FULL_ANALYSIS_FILES = 50;

/** Maximum files to include at all (even as summary). */
const MAX_TOTAL_FILES = 150;

/** Approximate token budget for all file contexts combined. */
const TOKEN_BUDGET = 500_000;

/** Rough estimate: 1 line of code ≈ 10 tokens. */
const TOKENS_PER_LINE = 10;

/** File extensions that are binary / non-reviewable. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib",
  ".pyc", ".pyo", ".class", ".jar", ".war",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".sqlite", ".db", ".lock",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(ext);
}

export interface PrioritizedFile {
  file: DiffFile;
  priority: number;
  /** Whether this file should receive full agent analysis. */
  fullAnalysis: boolean;
}

/**
 * Prioritize and partition diff files for analysis.
 *
 * Returns files sorted by priority with `fullAnalysis` set to `true` for the
 * top N files (up to MAX_FULL_ANALYSIS_FILES) and `false` for the rest.
 * Files that exceed the total cap are dropped entirely.
 */
export function prioritizeFiles(diffFiles: DiffFile[], userPriorityFiles?: string[]): PrioritizedFile[] {
  // Filter out binary files before scoring
  const reviewableFiles = diffFiles.filter((file) => {
    if (isBinaryPath(file.path)) {
      log.debug({ path: file.path }, "Skipping binary file");
      return false;
    }
    // Also skip files whose diff contains only "Binary files differ"
    if (file.diff.includes("Binary files") && file.additions === 0 && file.deletions === 0) {
      log.debug({ path: file.path }, "Skipping binary diff");
      return false;
    }
    return true;
  });

  if (reviewableFiles.length < diffFiles.length) {
    log.info(
      { total: diffFiles.length, reviewable: reviewableFiles.length, binary: diffFiles.length - reviewableFiles.length },
      "Filtered out binary files",
    );
  }

  // Score each file
  const scored = reviewableFiles.map((file) => {
    const linesChanged = file.additions + file.deletions;
    let score = calculateFilePriority(file.path, linesChanged);

    // Boost priority for user-specified files
    if (userPriorityFiles && userPriorityFiles.some((pf) => file.path.includes(pf) || pf.includes(file.path))) {
      score += 1000;
    }

    return {
      file,
      priority: score,
      linesChanged,
    };
  });

  // Sort by priority descending
  scored.sort((a, b) => b.priority - a.priority);

  // Apply token budget
  let tokenBudgetUsed = 0;
  const result: PrioritizedFile[] = [];

  for (let i = 0; i < scored.length && i < MAX_TOTAL_FILES; i++) {
    const item = scored[i]!;
    const estimatedTokens = item.linesChanged * TOKENS_PER_LINE;

    const withinBudget = tokenBudgetUsed + estimatedTokens <= TOKEN_BUDGET;
    const isFullAnalysis = i < MAX_FULL_ANALYSIS_FILES && withinBudget;

    if (isFullAnalysis) {
      tokenBudgetUsed += estimatedTokens;
    }

    result.push({
      file: item.file,
      priority: item.priority,
      fullAnalysis: isFullAnalysis,
    });
  }

  const dropped = diffFiles.length - result.length;
  if (dropped > 0) {
    log.warn(
      { total: diffFiles.length, kept: result.length, dropped },
      "Dropped low-priority files due to size limits",
    );
  }

  const fullCount = result.filter((r) => r.fullAnalysis).length;
  const summaryCount = result.length - fullCount;

  log.info(
    { total: result.length, fullAnalysis: fullCount, summaryOnly: summaryCount },
    "Files prioritized for review",
  );

  return result;
}

/**
 * Create batches of files for parallel agent processing.
 *
 * Each batch contains at most `batchSize` files. This allows the review
 * workflow to process files in manageable chunks and report progress.
 */
export function batchFiles<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}
