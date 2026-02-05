import type { Finding, Severity } from "../types/findings.ts";
import type { DiffFile } from "../types/bitbucket.ts";

export type FilterDropCounts = {
  missingLocation: number;
  outOfDiff: number;
  apiChangeNoEvidence: number;
  duplicationNoEvidence: number;
  lowConfidence: number;
  speculativeLowInfo: number;
  apiChangeEvidenceFiles?: Record<string, string[]>;
};

const CONFIDENCE_THRESHOLDS: Record<Severity, number> = {
  critical: 0.6,
  high: 0.6,
  medium: 0.7,
  low: 0.8,
  info: 0.8,
};

const SPECULATIVE_REGEX = /\b(potential|verify|might)\b/i;

/**
 * Collect all new-side line numbers that appear in the diff hunks.
 * These are lines that Bitbucket will show in the diff view.
 */
export function getDiffNewLines(diffFile: DiffFile): Set<number> {
  const validLines = new Set<number>();
  const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  const lines = diffFile.diff.split("\n");
  let currentNewLine: number | null = null;

  for (const rawLine of lines) {
    if (rawLine.startsWith("\\ No newline at end of file")) {
      continue;
    }
    const hunkMatch = rawLine.match(hunkRegex);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1]!, 10);
      continue;
    }
    if (currentNewLine === null) continue;
    if (rawLine.startsWith("-")) {
      // Deleted line — no new-side line number
    } else if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      validLines.add(currentNewLine);
      currentNewLine++;
    } else if (rawLine.startsWith(" ") || rawLine === "") {
      validLines.add(currentNewLine);
      currentNewLine++;
    }
  }

  return validLines;
}

function hasApiChangeEvidence(finding: Finding): boolean {
  if (!Array.isArray(finding.affectedFiles) || finding.affectedFiles.length === 0) {
    return false;
  }
  const sourceFile = typeof finding.file === "string" ? finding.file.trim() : "";
  if (!sourceFile) return true;
  return finding.affectedFiles.some((entry) => entry.file && entry.file !== sourceFile);
}

function hasDuplicationEvidence(finding: Finding): boolean {
  if (!finding.relatedCode) return false;
  if (typeof finding.relatedCode.similarity !== "number") return false;
  return finding.relatedCode.similarity >= 0.9;
}

function normalizeConfidence(confidence: number | undefined): number {
  const value = typeof confidence === "number" ? confidence : 0;
  return Number.isFinite(value) ? value : 0;
}

function isSpeculativeLowInfo(finding: Finding, confidence: number): boolean {
  if (finding.severity !== "low" && finding.severity !== "info") return false;
  if (confidence >= 0.85) return false;
  const text = `${finding.title} ${finding.description} ${finding.suggestion ?? ""}`;
  return SPECULATIVE_REGEX.test(text);
}

export function filterFindingsForQuality(
  findings: Finding[],
  diffMap: Map<string, DiffFile>,
): { findings: Finding[]; dropped: FilterDropCounts } {
  const dropped: FilterDropCounts = {
    missingLocation: 0,
    outOfDiff: 0,
    apiChangeNoEvidence: 0,
    duplicationNoEvidence: 0,
    lowConfidence: 0,
    speculativeLowInfo: 0,
    apiChangeEvidenceFiles: {},
  };

  const kept: Finding[] = [];

  for (const finding of findings) {
    const file = typeof finding.file === "string" ? finding.file.trim() : "";
    const line = Number(finding.line);
    if (!file || !Number.isInteger(line) || line <= 0) {
      dropped.missingLocation++;
      continue;
    }

    const diffFile = diffMap.get(file);
    if (!diffFile || diffFile.status === "deleted") {
      dropped.outOfDiff++;
      continue;
    }

    const validLines = getDiffNewLines(diffFile);
    if (!validLines.has(line)) {
      dropped.outOfDiff++;
      continue;
    }

    if (finding.category === "api-change" && !hasApiChangeEvidence(finding)) {
      dropped.apiChangeNoEvidence++;
      continue;
    }

    if (finding.category === "api-change" && finding.affectedFiles) {
      const externalFiles = finding.affectedFiles
        .filter((entry) => entry.file && entry.file !== file)
        .map((entry) => entry.file);
      if (externalFiles.length > 0 && dropped.apiChangeEvidenceFiles) {
        dropped.apiChangeEvidenceFiles[finding.title] = externalFiles;
      }
    }

    if (finding.category === "duplication" && !hasDuplicationEvidence(finding)) {
      dropped.duplicationNoEvidence++;
      continue;
    }

    const confidence = normalizeConfidence(finding.confidence);
    const threshold = CONFIDENCE_THRESHOLDS[finding.severity] ?? 0.8;
    if (confidence < threshold) {
      dropped.lowConfidence++;
      continue;
    }

    if (isSpeculativeLowInfo(finding, confidence)) {
      dropped.speculativeLowInfo++;
      continue;
    }

    kept.push(finding);
  }

  return { findings: kept, dropped };
}

export function filterFindingsForInline(findings: Finding[]): Finding[] {
  return findings.filter((finding) => (
    finding.severity === "critical" || finding.severity === "high" || finding.severity === "medium"
  ));
}

export function resolveCommentLine(
  filePath: string,
  line: number,
  diffMap: Map<string, DiffFile>,
): number | null {
  const diffFile = diffMap.get(filePath);
  if (!diffFile || diffFile.status === "deleted") return null;
  if (!Number.isInteger(line) || line <= 0) return null;
  const validLines = getDiffNewLines(diffFile);
  return validLines.has(line) ? line : null;
}

/**
 * Patterns that indicate similar/redundant findings that should be consolidated.
 * Each pattern has a regex to match and a label for the consolidated finding.
 */
const SIMILAR_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\b(null|undefined)\s*(check|guard|safe)/i, label: "null/undefined check" },
  { regex: /\bmissing\s+null/i, label: "null/undefined check" },
  { regex: /\bgetElementById.*null/i, label: "DOM element null check" },
  { regex: /\bDOM\s+element.*null/i, label: "DOM element null check" },
  { regex: /\bunchecked.*access/i, label: "unchecked property access" },
  { regex: /\boptional\s+chain/i, label: "optional chaining" },
];

function getPatternLabel(finding: Finding): string | null {
  const text = `${finding.title} ${finding.description}`;
  for (const pattern of SIMILAR_PATTERNS) {
    if (pattern.regex.test(text)) {
      return pattern.label;
    }
  }
  return null;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/**
 * Consolidate similar findings in the same file to reduce noise.
 *
 * For example, if there are 6 "missing null check" findings in the same file,
 * consolidate them into 1 finding that mentions all affected lines.
 *
 * Returns the deduplicated findings and the count of removed duplicates.
 */
/**
 * Extract the code content at a specific line from a diff.
 * Returns null if the line is not found.
 */
export function getCodeAtLine(diffFile: DiffFile, targetLine: number): string | null {
  const lines = diffFile.diff.split("\n");
  const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
  let currentNewLine: number | null = null;

  for (const line of lines) {
    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }
    const hunkMatch = line.match(hunkRegex);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1]!, 10);
      continue;
    }
    if (currentNewLine === null) continue;

    if (line.startsWith("-")) {
      // Deleted line — no new-side line number, skip
      continue;
    }

    if (currentNewLine === targetLine) {
      // Return the line content without the diff prefix
      if (line.startsWith("+")) return line.slice(1);
      return line.startsWith(" ") ? line.slice(1) : line;
    }

    currentNewLine++;
  }

  return null;
}

/**
 * Extract keywords/identifiers from a finding that should appear in the code.
 * Returns an array of expected tokens.
 */
function extractExpectedTokens(finding: Finding): string[] {
  const tokens: string[] = [];
  const text = `${finding.title} ${finding.description}`;

  // Extract quoted identifiers like 'getElementById', "brand_radio", etc.
  const quotedMatches = text.match(/['"`](\w+)['"`]/g) ?? [];
  for (const match of quotedMatches) {
    const token = match.slice(1, -1);
    if (token.length >= 3) tokens.push(token);
  }

  // Extract DOM element IDs mentioned
  const domIdMatches = text.match(/getElementById\s*\(\s*['"`](\w+)['"`]/gi) ?? [];
  for (const match of domIdMatches) {
    const idMatch = match.match(/['"`](\w+)['"`]/);
    if (idMatch && idMatch[1]) tokens.push(idMatch[1]);
  }

  // Extract property access patterns like .checked, .value, .disabled
  const propMatches = text.match(/\.(\w+)\b/g) ?? [];
  for (const match of propMatches) {
    const prop = match.slice(1);
    if (prop.length >= 3 && !["the", "and", "for", "this"].includes(prop.toLowerCase())) {
      tokens.push(prop);
    }
  }

  return [...new Set(tokens)];
}

/**
 * Validate that a finding's reported line contains code that matches the finding description.
 *
 * This catches cases where an agent reported the wrong line number but the line
 * still exists in the diff (so it passes the basic validity check).
 *
 * Returns true if the finding appears valid, false if it should be dropped.
 */
export function validateFindingContent(
  finding: Finding,
  diffFile: DiffFile,
): { valid: boolean; reason?: string } {
  const code = getCodeAtLine(diffFile, finding.line);

  // If we couldn't get the code, let it pass (validation is best-effort)
  if (!code) return { valid: true };

  const expectedTokens = extractExpectedTokens(finding);

  // If we couldn't extract any expected tokens, let it pass
  if (expectedTokens.length === 0) return { valid: true };

  // Check if at least one expected token appears in the code at this line
  const codeUpper = code.toUpperCase();
  const foundToken = expectedTokens.some((token) =>
    codeUpper.includes(token.toUpperCase()),
  );

  if (foundToken) return { valid: true };

  // None of the expected tokens found - this is likely a misaligned comment
  return {
    valid: false,
    reason: `Expected tokens [${expectedTokens.slice(0, 3).join(", ")}] not found in code at line ${finding.line}: "${code.slice(0, 80)}..."`,
  };
}

/**
 * Filter findings by validating that the code at the reported line matches
 * the finding description. Drops findings where there's a mismatch.
 */
export function filterFindingsByContent(
  findings: Finding[],
  diffMap: Map<string, DiffFile>,
): { findings: Finding[]; droppedForContentMismatch: number } {
  const kept: Finding[] = [];
  let droppedForContentMismatch = 0;

  for (const finding of findings) {
    const diffFile = diffMap.get(finding.file);
    if (!diffFile) {
      kept.push(finding);
      continue;
    }

    const validation = validateFindingContent(finding, diffFile);
    if (validation.valid) {
      kept.push(finding);
    } else {
      droppedForContentMismatch++;
      // Could log validation.reason here for debugging
    }
  }

  return { findings: kept, droppedForContentMismatch };
}

export function consolidateSimilarFindings(
  findings: Finding[],
): { findings: Finding[]; consolidatedCount: number } {
  // Group by file and pattern
  const groups = new Map<string, Finding[]>();
  const nonGrouped: Finding[] = [];

  for (const finding of findings) {
    const patternLabel = getPatternLabel(finding);
    if (patternLabel) {
      const key = `${finding.file}::${patternLabel}`;
      const group = groups.get(key) ?? [];
      group.push(finding);
      groups.set(key, group);
    } else {
      nonGrouped.push(finding);
    }
  }

  const result: Finding[] = [...nonGrouped];
  let consolidatedCount = 0;

  for (const [key, group] of groups) {
    if (group.length === 1) {
      // Only one finding with this pattern, keep as-is
      result.push(group[0]!);
      continue;
    }

    // Multiple findings with same pattern - consolidate
    consolidatedCount += group.length - 1;

    // Sort by severity (highest first), then confidence (highest first)
    group.sort((a, b) => {
      const severityDiff = (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
      if (severityDiff !== 0) return severityDiff;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });

    const best = group[0]!;
    const allLines = group.map((f) => f.line).sort((a, b) => a - b);
    const patternLabel = key.split("::")[1] ?? "similar issue";

    // Create consolidated finding
    const consolidated: Finding = {
      ...best,
      title: `Multiple ${patternLabel} issues (${group.length} occurrences)`,
      description: `${best.description}\n\n**Note:** This pattern appears at ${group.length} locations in this file (lines ${allLines.join(", ")}). Consider reviewing all occurrences together.`,
      // Cap confidence for pattern-match consolidations
      confidence: Math.min(best.confidence ?? 0.8, 0.75),
      // Downgrade severity if it was high/critical for a pattern-match
      severity: best.severity === "critical" ? "high" : (best.severity === "high" ? "medium" : best.severity),
    };

    result.push(consolidated);
  }

  return { findings: result, consolidatedCount };
}
