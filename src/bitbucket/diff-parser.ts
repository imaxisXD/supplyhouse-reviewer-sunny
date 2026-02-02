import type { DiffFile, DiffHunk, DiffChange } from "../types/bitbucket.ts";

/**
 * Regex to match the file header lines in a unified diff.
 *
 * Captures:
 *   [1] old file path (after "a/")
 *   [2] new file path (after "b/")
 */
const FILE_HEADER_REGEX = /^diff --git a\/(.+?) b\/(.+?)$/;

/**
 * Regex to match hunk headers: @@ -oldStart[,oldLines] +newStart[,newLines] @@
 *
 * Captures:
 *   [1] oldStart
 *   [2] oldLines (optional, defaults to 1)
 *   [3] newStart
 *   [4] newLines (optional, defaults to 1)
 */
const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse a unified diff string into an array of structured DiffFile objects.
 *
 * Handles:
 *  - File headers (--- a/path, +++ b/path)
 *  - Hunk headers (@@ -old +new @@)
 *  - Added (+), removed (-), and context lines
 *  - File status detection: added, deleted, renamed, modified
 */
export function parseDiff(rawDiff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = rawDiff.split("\n");

  let currentFile: Partial<DiffFile> | null = null;
  let currentHunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldPath: string = "";
  let newPath: string = "";
  let additions = 0;
  let deletions = 0;
  let diffLines: string[] = [];
  let oldLineNum = 0;
  let newLineNum = 0;

  function flushFile(): void {
    if (!currentFile) return;

    if (currentHunk) {
      currentHunks.push(currentHunk);
    }

    const status = detectStatus(oldPath, newPath);
    const file: DiffFile = {
      path: newPath === "/dev/null" ? oldPath : newPath,
      status,
      diff: diffLines.join("\n"),
      additions,
      deletions,
    };

    if (status === "renamed" && oldPath !== newPath) {
      file.oldPath = oldPath;
    }

    files.push(file);

    // Reset per-file state
    currentFile = null;
    currentHunks = [];
    currentHunk = null;
    diffLines = [];
    additions = 0;
    deletions = 0;
    oldPath = "";
    newPath = "";
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ----- File header -----
    const fileMatch = line.match(FILE_HEADER_REGEX);
    if (fileMatch) {
      flushFile();
      currentFile = {};
      oldPath = fileMatch[1]!;
      newPath = fileMatch[2]!;
      diffLines.push(line);
      continue;
    }

    if (!currentFile) continue;

    // Collect raw diff text for every line belonging to this file
    diffLines.push(line);

    // --- / +++ lines (overwrite paths with more specific values when present)
    if (line.startsWith("--- ")) {
      const path = extractPath(line.slice(4));
      if (path) oldPath = path;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = extractPath(line.slice(4));
      if (path) newPath = path;
      continue;
    }

    // ----- Hunk header -----
    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      if (currentHunk) {
        currentHunks.push(currentHunk);
      }
      oldLineNum = parseInt(hunkMatch[1]!, 10);
      newLineNum = parseInt(hunkMatch[3]!, 10);
      currentHunk = {
        oldStart: oldLineNum,
        oldLines: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: newLineNum,
        newLines: parseInt(hunkMatch[4] ?? "1", 10),
        changes: [],
      };
      continue;
    }

    // ----- Change lines inside a hunk -----
    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      const change: DiffChange = {
        type: "add",
        lineNew: newLineNum,
        content: line.slice(1),
      };
      currentHunk.changes.push(change);
      newLineNum++;
      additions++;
    } else if (line.startsWith("-")) {
      const change: DiffChange = {
        type: "delete",
        lineOld: oldLineNum,
        content: line.slice(1),
      };
      currentHunk.changes.push(change);
      oldLineNum++;
      deletions++;
    } else if (line.startsWith(" ") || line === "") {
      // Context line (or empty trailing line within hunk)
      const change: DiffChange = {
        type: "context",
        lineOld: oldLineNum,
        lineNew: newLineNum,
        content: line.startsWith(" ") ? line.slice(1) : line,
      };
      currentHunk.changes.push(change);
      oldLineNum++;
      newLineNum++;
    }
    // Skip lines like "\ No newline at end of file"
  }

  // Flush any remaining file
  flushFile();

  return files;
}

/**
 * Map a diff-relative line number (1-indexed position within the diff) to the
 * actual file line number in the *new* version of the file.
 *
 * This is useful when posting inline comments: BitBucket expects a line number
 * in the new file, but callers may only know the diff line offset.
 *
 * Returns `null` if the diffLine does not correspond to a line present in the
 * new file (e.g. a deleted line).
 */
export function mapDiffLineToFileLine(
  diffFile: DiffFile,
  diffLine: number,
): number | null {
  const rawLines = diffFile.diff.split("\n");
  let currentNewLine: number | null = null;
  let diffPosition = 0;

  for (const rawLine of rawLines) {
    // Hunk header - reset position counters
    const hunkMatch = rawLine.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[3]!, 10);
      diffPosition++;
      continue;
    }

    // Only count lines within hunks
    if (currentNewLine === null) {
      diffPosition++;
      continue;
    }

    diffPosition++;

    if (diffPosition === diffLine) {
      if (rawLine.startsWith("-")) {
        // Deleted line -- no corresponding line in new file
        return null;
      }
      return currentNewLine;
    }

    // Advance line counters
    if (rawLine.startsWith("+")) {
      currentNewLine++;
    } else if (rawLine.startsWith("-")) {
      // old line only -- new line counter stays
    } else {
      // Context line
      currentNewLine++;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the file status based on old and new paths.
 */
function detectStatus(
  old: string,
  newP: string,
): DiffFile["status"] {
  if (old === "/dev/null" || old === "dev/null") return "added";
  if (newP === "/dev/null" || newP === "dev/null") return "deleted";
  if (old !== newP) return "renamed";
  return "modified";
}

/**
 * Extract the file path from a `--- a/path` or `+++ b/path` line value.
 * Strips the leading `a/` or `b/` prefix.
 * Preserves `/dev/null` as-is.
 */
function extractPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "/dev/null") return "/dev/null";
  // Strip a/ or b/ prefix
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}
