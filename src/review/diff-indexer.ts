import type { DiffFile, DiffHunk } from "../types/bitbucket.ts";
import type { Finding } from "../types/findings.ts";
import { createHash } from "crypto";

export type DiffLineKind = "add" | "delete" | "context";

export interface DiffIndexedLine {
  kind: DiffLineKind;
  raw: string;
  content: string;
  newLine?: number;
  oldLine?: number;
}

export interface DiffBlock {
  kind: "add" | "delete";
  file: string;
  startOld?: number;
  endOld?: number;
  startNew?: number;
  endNew?: number;
  lines: string[];
  normalized: string;
  hash: string;
}

export interface MoveFact {
  kind: "moved";
  from: { file: string; startLine: number; endLine: number };
  to: { file: string; startLine: number; endLine: number };
  hash: string;
  sizeLines: number;
}

export interface DiffFileIndex {
  file: string;
  lines: DiffIndexedLine[];
  newLineSet: Set<number>;
  addedBlocks: DiffBlock[];
  deletedBlocks: DiffBlock[];
  hunks?: DiffHunk[];
  moveFacts: MoveFact[];
}

export interface DiffIndex {
  files: Map<string, DiffFileIndex>;
  moveFacts: MoveFact[];
}

const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function isMetaDiffLine(line: string): boolean {
  return line.startsWith("\\ No newline at end of file");
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function normalizeBlock(lines: string[]): string {
  const normalized: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (isCommentOnlyLine(trimmed)) continue;
    normalized.push(trimmed.replace(/\s+/g, " "));
  }
  return normalized.join("\n");
}

function isCommentOnlyLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("<!--") ||
    trimmed.startsWith("-->") ||
    trimmed.startsWith("<#--") ||
    trimmed.startsWith("--#>")
  );
}

export function buildDiffIndex(diffFiles: DiffFile[]): DiffIndex {
  const files = new Map<string, DiffFileIndex>();
  const deletedByHash = new Map<string, DiffBlock[]>();
  const addedByHash = new Map<string, DiffBlock[]>();

  for (const diffFile of diffFiles) {
    const indexed = indexDiffFile(diffFile);
    files.set(diffFile.path, indexed);

    for (const block of indexed.deletedBlocks) {
      const list = deletedByHash.get(block.hash) ?? [];
      list.push(block);
      deletedByHash.set(block.hash, list);
    }
    for (const block of indexed.addedBlocks) {
      const list = addedByHash.get(block.hash) ?? [];
      list.push(block);
      addedByHash.set(block.hash, list);
    }
  }

  const moveFacts: MoveFact[] = [];
  for (const [hash, deletes] of deletedByHash.entries()) {
    const adds = addedByHash.get(hash);
    if (!adds || adds.length === 0) continue;
    const pairCount = Math.min(deletes.length, adds.length);
    for (let i = 0; i < pairCount; i++) {
      const from = deletes[i]!;
      const to = adds[i]!;
      const fromStart = from.startOld ?? 0;
      const fromEnd = from.endOld ?? fromStart;
      const toStart = to.startNew ?? 0;
      const toEnd = to.endNew ?? toStart;
      if (fromStart <= 0 || toStart <= 0) continue;
      const fact: MoveFact = {
        kind: "moved",
        from: { file: from.file, startLine: fromStart, endLine: fromEnd },
        to: { file: to.file, startLine: toStart, endLine: toEnd },
        hash,
        sizeLines: to.lines.length,
      };
      moveFacts.push(fact);
      const fromIndex = files.get(from.file);
      const toIndex = files.get(to.file);
      if (fromIndex) fromIndex.moveFacts.push(fact);
      if (toIndex && toIndex !== fromIndex) toIndex.moveFacts.push(fact);
    }
  }

  return { files, moveFacts };
}

function indexDiffFile(diffFile: DiffFile): DiffFileIndex {
  const lines: DiffIndexedLine[] = [];
  const newLineSet = new Set<number>();
  const addedBlocks: DiffBlock[] = [];
  const deletedBlocks: DiffBlock[] = [];

  const rawLines = diffFile.diff.split("\n");
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let currentBlock: DiffBlock | null = null;

  function finalizeBlock(): void {
    if (!currentBlock) return;
    const normalized = normalizeBlock(currentBlock.lines);
    if (normalized.length > 0) {
      currentBlock.normalized = normalized;
      currentBlock.hash = hashText(normalized);
      if (currentBlock.kind === "add") {
        addedBlocks.push(currentBlock);
      } else {
        deletedBlocks.push(currentBlock);
      }
    }
    currentBlock = null;
  }

  for (const rawLine of rawLines) {
    if (isMetaDiffLine(rawLine)) {
      continue;
    }

    const hunkMatch = rawLine.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      finalizeBlock();
      oldLine = parseInt(hunkMatch[1]!, 10);
      newLine = parseInt(hunkMatch[3]!, 10);
      continue;
    }

    if (oldLine === null || newLine === null) continue;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const content = rawLine.slice(1);
      const lineNo = newLine;
      lines.push({ kind: "add", raw: rawLine, content, newLine: lineNo });
      newLineSet.add(lineNo);

      if (!currentBlock || currentBlock.kind !== "add") {
        finalizeBlock();
        currentBlock = {
          kind: "add",
          file: diffFile.path,
          startNew: lineNo,
          endNew: lineNo,
          lines: [content],
          normalized: "",
          hash: "",
        };
      } else {
        currentBlock.lines.push(content);
        currentBlock.endNew = lineNo;
      }

      newLine++;
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      const content = rawLine.slice(1);
      const lineNo = oldLine;
      lines.push({ kind: "delete", raw: rawLine, content, oldLine: lineNo });

      if (!currentBlock || currentBlock.kind !== "delete") {
        finalizeBlock();
        currentBlock = {
          kind: "delete",
          file: diffFile.path,
          startOld: lineNo,
          endOld: lineNo,
          lines: [content],
          normalized: "",
          hash: "",
        };
      } else {
        currentBlock.lines.push(content);
        currentBlock.endOld = lineNo;
      }

      oldLine++;
      continue;
    }

    if (rawLine.startsWith(" ") || rawLine === "") {
      const content = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
      lines.push({
        kind: "context",
        raw: rawLine,
        content,
        newLine,
        oldLine,
      });
      newLineSet.add(newLine);
      oldLine++;
      newLine++;
      if (currentBlock) finalizeBlock();
      continue;
    }
  }

  finalizeBlock();

  return {
    file: diffFile.path,
    lines,
    newLineSet,
    addedBlocks,
    deletedBlocks,
    hunks: diffFile.hunks,
    moveFacts: [],
  };
}

export interface SummaryDiffOptions {
  contextLines?: number;
  maxLines?: number;
}

export function buildSummaryDiff(diffFile: DiffFile, options?: SummaryDiffOptions): string {
  const contextLines = options?.contextLines ?? 3;
  const maxLines = options?.maxLines ?? 200;

  const lines = diffFile.diff.split("\n");
  const output: string[] = [];
  let headerBuffer: string[] = [];
  let currentHunkHeader: string | null = null;
  let hunkLines: string[] = [];

  function flushHunk(): void {
    if (!currentHunkHeader) return;
    const selected = selectHunkLines(hunkLines, contextLines);
    output.push(currentHunkHeader, ...selected);
    currentHunkHeader = null;
    hunkLines = [];
  }

  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (!currentHunkHeader) {
        headerBuffer.push(line);
      }
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      flushHunk();
      if (headerBuffer.length > 0 && output.length === 0) {
        output.push(...headerBuffer);
      }
      currentHunkHeader = line;
      hunkLines = [];
      continue;
    }

    if (currentHunkHeader) {
      hunkLines.push(line);
    }
  }

  flushHunk();

  if (output.length === 0 && headerBuffer.length > 0) {
    output.push(...headerBuffer);
  }

  if (output.length > maxLines) {
    // Drop context lines first, keep change lines and hunk headers.
    let trimmed = output.slice();
    for (let i = trimmed.length - 1; i >= 0 && trimmed.length > maxLines; i--) {
      const line = trimmed[i]!;
      if (line.startsWith("@@")) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) continue;
      if (line.startsWith("-") && !line.startsWith("---")) continue;
      if (line.startsWith(" ") || line === "") {
        trimmed.splice(i, 1);
      }
    }
    output.length = 0;
    output.push(...trimmed);
  }

  return output.join("\n");
}

function selectHunkLines(lines: string[], contextLines: number): string[] {
  const include = new Array(lines.length).fill(false);
  const changeIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("+") && !line.startsWith("+++")) changeIndices.push(i);
    else if (line.startsWith("-") && !line.startsWith("---")) changeIndices.push(i);
  }

  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    for (let i = start; i <= end; i++) {
      include[i] = true;
    }
  }

  // Always include change lines even if contextLines = 0
  for (const idx of changeIndices) {
    include[idx] = true;
  }

  return lines.filter((_, i) => include[i]);
}

export interface LineResolutionResult {
  line: number | null;
  resolvedBy: "lineId" | "lineText" | "original" | "none";
}

export function resolveFindingLine(
  finding: Finding,
  diffIndex: DiffIndex,
): LineResolutionResult {
  const fileIndex = diffIndex.files.get(finding.file);
  if (!fileIndex) return { line: null, resolvedBy: "none" };

  const lineId = typeof finding.lineId === "string" ? finding.lineId.trim() : "";
  if (lineId.startsWith("L")) {
    const match = lineId.match(/\d+/);
    const parsed = match ? Number(match[0]) : NaN;
    if (Number.isInteger(parsed) && fileIndex.newLineSet.has(parsed)) {
      return { line: parsed, resolvedBy: "lineId" };
    }
  }

  const lineText = normalizeLineText(finding.lineText);
  if (lineText.length > 0) {
    const candidates = fileIndex.lines
      .filter((line) => typeof line.newLine === "number")
      .filter((line) => {
        const content = line.content.trim();
        return content === lineText || content.includes(lineText) || lineText.includes(content);
      })
      .map((line) => line.newLine as number);

    if (candidates.length > 0) {
      const target = Number.isFinite(finding.line) ? finding.line : candidates[0]!;
      const best = candidates.reduce((a, b) =>
        Math.abs(a - target) <= Math.abs(b - target) ? a : b,
      );
      return { line: best, resolvedBy: "lineText" };
    }
  }

  if (Number.isInteger(finding.line) && fileIndex.newLineSet.has(finding.line)) {
    return { line: finding.line, resolvedBy: "original" };
  }

  return { line: null, resolvedBy: "none" };
}

export function applyLineResolution(
  findings: Finding[],
  diffIndex: DiffIndex,
): { findings: Finding[]; corrected: number; dropped: number } {
  let corrected = 0;
  let dropped = 0;
  const resolved: Finding[] = [];

  for (const finding of findings) {
    const result = resolveFindingLine(finding, diffIndex);
    if (result.line === null) {
      dropped++;
      continue;
    }
    if (result.line !== finding.line) {
      corrected++;
    }
    resolved.push({ ...finding, line: result.line });
  }

  return { findings: resolved, corrected, dropped };
}

const DELETION_PATTERN = /\b(deleted|removed|no longer|deleted from|removed from)\b/i;

export function suppressMoveFalsePositives(
  findings: Finding[],
  diffIndex: DiffIndex,
): { findings: Finding[]; suppressed: number } {
  const kept: Finding[] = [];
  let suppressed = 0;
  const movedHashes = new Set(diffIndex.moveFacts.map((fact) => fact.hash));

  for (const finding of findings) {
    if (!DELETION_PATTERN.test(`${finding.title} ${finding.description}`)) {
      kept.push(finding);
      continue;
    }
    const lineText = normalizeLineText(finding.lineText);
    if (!lineText) {
      kept.push(finding);
      continue;
    }

    const fileIndex = diffIndex.files.get(finding.file);
    if (!fileIndex) {
      kept.push(finding);
      continue;
    }

    const isInMovedBlock = fileIndex.addedBlocks.some((block) => {
      if (!movedHashes.has(block.hash)) return false;
      return block.lines.some((line) => line.trim() === lineText);
    });

    if (isInMovedBlock) {
      suppressed++;
      continue;
    }

    kept.push(finding);
  }

  return { findings: kept, suppressed };
}

function normalizeLineText(lineText?: string): string {
  if (!lineText) return "";
  const trimmed = lineText.trim();
  return trimmed.replace(/^[-+]\s?/, "");
}
