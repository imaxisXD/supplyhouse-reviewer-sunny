/**
 * Parsers for extracting structured data from agent text responses.
 *
 * Each agent returns its findings/results embedded in JSON within a text
 * response. These parsers safely extract and validate that JSON.
 */

import type { Finding, Severity, Category } from "../types/findings.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("response-parsers");

// ---------------------------------------------------------------------------
// Planner output
// ---------------------------------------------------------------------------

export interface PlannerOutput {
  summary: string;
  focusFiles: string[];
  moveNotes: string[];
  riskNotes: string[];
  agentHints: string[];
}

export function parsePlannerOutput(text: string): PlannerOutput | null {
  try {
    const json = extractJsonObject(text);
    if (!json) return null;
    const parsed = JSON.parse(json) as Partial<PlannerOutput>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      focusFiles: Array.isArray(parsed.focusFiles) ? parsed.focusFiles.filter((v) => typeof v === "string") as string[] : [],
      moveNotes: Array.isArray(parsed.moveNotes) ? parsed.moveNotes.filter((v) => typeof v === "string") as string[] : [],
      riskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes.filter((v) => typeof v === "string") as string[] : [],
      agentHints: Array.isArray(parsed.agentHints) ? parsed.agentHints.filter((v) => typeof v === "string") as string[] : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Findings parser (from specialist agents)
// ---------------------------------------------------------------------------

export const VALID_SEVERITIES: Set<Severity> = new Set(["critical", "high", "medium", "low", "info"]);
export const VALID_CATEGORIES: Set<Category> = new Set(["security", "bug", "duplication", "api-change", "refactor"]);
export const AGENT_DEFAULT_CATEGORY: Record<string, Category> = {
  security: "security",
  logic: "bug",
  duplication: "duplication",
  "api-change": "api-change",
  refactor: "refactor",
  completeness: "security", // Missing controls are security-related
};

export function parseFindingsFromResponse(text: string, agentName: string): Finding[] {
  try {
    const json = extractJsonObject(text);
    if (!json) return [];
    const parsed = JSON.parse(json) as { findings?: unknown[] };
    if (!Array.isArray(parsed.findings)) return [];

    const findings: Finding[] = [];

    for (const item of parsed.findings) {
      const f = item as Record<string, unknown>;
      const related = f.relatedCode as Record<string, unknown> | undefined;
      const affected = Array.isArray(f.affectedFiles) ? f.affectedFiles as Record<string, unknown>[] : [];

      // Parse line number - try to get a valid line, but allow 0 if lineText is present
      // (will be resolved later from lineText by applyLineResolution)
      const rawLine = f.line;
      let line = typeof rawLine === "number" ? rawLine : parseInt(String(rawLine), 10);

      // Normalize invalid line numbers to 0 (will be resolved from lineText later)
      if (!Number.isFinite(line) || line < 0) {
        line = 0;
      }

      // Skip findings without both valid line number AND lineText - they can't be resolved
      const hasLineText = typeof f.lineText === "string" && f.lineText.trim().length > 0;
      if (line <= 0 && !hasLineText) {
        log.warn(
          { agent: agentName, file: f.file, title: f.title, rawLine },
          "Skipping finding with no line number and no lineText - cannot resolve location"
        );
        continue;
      }

      if (line <= 0 && hasLineText) {
        log.debug(
          { agent: agentName, file: f.file, title: f.title, lineText: f.lineText },
          "Finding has no line number but has lineText - will attempt resolution"
        );
      }

      // Validate severity against known values
      const rawSeverity = typeof f.severity === "string" ? f.severity.toLowerCase() : "";
      const severity: Severity = VALID_SEVERITIES.has(rawSeverity as Severity)
        ? (rawSeverity as Severity)
        : "info";

      // Validate category against known values, using agent-specific default
      const rawCategory = typeof f.category === "string" ? f.category.toLowerCase() : "";
      const category: Category = VALID_CATEGORIES.has(rawCategory as Category)
        ? (rawCategory as Category)
        : (AGENT_DEFAULT_CATEGORY[agentName] ?? "bug");

      // Extract optional investigation trail
      const rawInvestigation = f.investigation as Record<string, unknown> | undefined;
      const investigation = rawInvestigation
        ? {
            toolsUsed: Array.isArray(rawInvestigation.toolsUsed)
              ? (rawInvestigation.toolsUsed as unknown[]).filter((v): v is string => typeof v === "string")
              : [],
            filesChecked: Array.isArray(rawInvestigation.filesChecked)
              ? (rawInvestigation.filesChecked as unknown[]).filter((v): v is string => typeof v === "string")
              : [],
            patternsSearched: Array.isArray(rawInvestigation.patternsSearched)
              ? (rawInvestigation.patternsSearched as unknown[]).filter((v): v is string => typeof v === "string")
              : [],
            conclusion: typeof rawInvestigation.conclusion === "string" ? rawInvestigation.conclusion : "",
          }
        : undefined;

      findings.push({
        file: String(f.file ?? ""),
        line,
        severity,
        category,
        title: String(f.title ?? ""),
        description: String(f.description ?? ""),
        suggestion: f.suggestion ? String(f.suggestion) : undefined,
        confidence: Number(f.confidence ?? 0.5),
        lineText: f.lineText ? String(f.lineText) : undefined,
        lineId: f.lineId ? String(f.lineId) : undefined,
        cwe: f.cwe ? String(f.cwe) : undefined,
        relatedCode: related && typeof related.file === "string"
          ? {
              file: String(related.file),
              line: Number(related.line ?? 0),
              functionName: String(related.functionName ?? ""),
              similarity: typeof related.similarity === "number" ? related.similarity : undefined,
            }
          : undefined,
        affectedFiles: affected.length > 0
          ? affected
              .filter((a) => typeof a.file === "string")
              .map((a) => ({
                file: String(a.file),
                line: Number(a.line ?? 0),
                usage: String(a.usage ?? ""),
              }))
          : undefined,
        investigation,
      });
    }

    return findings;
  } catch (error) {
    log.warn({ agent: agentName, error }, "Failed to parse agent findings");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Verification response parser
// ---------------------------------------------------------------------------

export function parseVerificationResponse(
  text: string,
  originalFindings: Finding[],
): { verified: Finding[]; disproven: Finding[]; disprovenCount: number } {
  try {
    const json = extractJsonObject(text);
    if (!json) {
      // If we can't parse, keep all original findings
      return { verified: originalFindings, disproven: [], disprovenCount: 0 };
    }

    const parsed = JSON.parse(json) as {
      verifiedFindings?: unknown[];
      disprovenFindings?: unknown[];
    };

    // Extract verified findings
    const verified: Finding[] = [];
    if (Array.isArray(parsed.verifiedFindings)) {
      for (const item of parsed.verifiedFindings) {
        const f = item as Record<string, unknown>;
        // Reconstruct finding with verification notes
        const finding: Finding = {
          file: String(f.file ?? ""),
          line: Number(f.line ?? 0),
          severity: (f.severity as Severity) ?? "info",
          category: (f.category as Category) ?? "bug",
          title: String(f.title ?? ""),
          description: String(f.description ?? ""),
          suggestion: f.suggestion ? String(f.suggestion) : undefined,
          confidence: Number(f.confidence ?? 0.5),
          lineText: f.lineText ? String(f.lineText) : undefined,
          lineId: f.lineId ? String(f.lineId) : undefined,
          cwe: f.cwe ? String(f.cwe) : undefined,
        };

        // Add verification notes if present
        if (f.verificationNotes) {
          finding.verificationNotes = String(f.verificationNotes);
        }

        verified.push(finding);
      }
    }

    // Extract disproven findings with reason
    const disproven: Finding[] = [];
    if (Array.isArray(parsed.disprovenFindings)) {
      for (const item of parsed.disprovenFindings) {
        const f = item as Record<string, unknown>;
        const finding: Finding = {
          file: String(f.file ?? ""),
          line: Number(f.line ?? 0),
          severity: (f.severity as Severity) ?? "info",
          category: (f.category as Category) ?? "bug",
          title: String(f.title ?? ""),
          description: String(f.description ?? ""),
          suggestion: f.suggestion ? String(f.suggestion) : undefined,
          confidence: Number(f.confidence ?? 0.5),
          lineText: f.lineText ? String(f.lineText) : undefined,
          lineId: f.lineId ? String(f.lineId) : undefined,
          cwe: f.cwe ? String(f.cwe) : undefined,
          // Mark as disproven with reason
          disproven: true,
          disprovenReason: f.reason ? String(f.reason) : "Marked as false positive by verification",
        };
        disproven.push(finding);
      }
    }

    const disprovenCount = disproven.length;

    // If nothing verified, return original findings (safety)
    if (verified.length === 0 && disprovenCount === 0) {
      return { verified: originalFindings, disproven: [], disprovenCount: 0 };
    }

    return { verified, disproven, disprovenCount };
  } catch (error) {
    log.warn({ error }, "Failed to parse verification response");
    return { verified: originalFindings, disproven: [], disprovenCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Synthesis output parser
// ---------------------------------------------------------------------------

export type SynthesisOutput = {
  findings: Finding[];
  inlineComments?: { file: string; line: number; content: string }[];
  summaryComment?: string;
  stats?: {
    totalFindings: number;
    duplicatesRemoved?: number;
    bySeverity?: Record<Severity, number>;
    byCategory?: Record<Category, number>;
  };
  recommendation?: string;
  confidenceScore?: number;
};

export function parseSynthesisOutput(text: string): SynthesisOutput | null {
  try {
    const json = extractJsonObject(text);
    if (!json) return null;
    const parsed = JSON.parse(json) as Record<string, unknown>;

    const parsedFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = parsedFindings.map((item: unknown) => {
      const f = item as Record<string, unknown>;
      const related = f.relatedCode as Record<string, unknown> | undefined;
      const affected = Array.isArray(f.affectedFiles) ? f.affectedFiles as Record<string, unknown>[] : [];
      return {
        file: String(f.file ?? ""),
        line: Number(f.line ?? 0),
        severity: (f.severity as Severity) ?? "info",
        category: (f.category as Category) ?? "bug",
        title: String(f.title ?? ""),
        description: String(f.description ?? ""),
        suggestion: f.suggestion ? String(f.suggestion) : undefined,
        confidence: Number(f.confidence ?? 0.5),
        lineText: f.lineText ? String(f.lineText) : undefined,
        lineId: f.lineId ? String(f.lineId) : undefined,
        cwe: f.cwe ? String(f.cwe) : undefined,
        relatedCode: related && typeof related.file === "string"
          ? {
              file: String(related.file),
              line: Number(related.line ?? 0),
              functionName: String(related.functionName ?? ""),
              similarity: typeof related.similarity === "number" ? related.similarity : undefined,
            }
          : undefined,
        affectedFiles: affected.length > 0
          ? affected
              .filter((a) => typeof a.file === "string")
              .map((a) => ({
                file: String(a.file),
                line: Number(a.line ?? 0),
                usage: String(a.usage ?? ""),
              }))
          : undefined,
      };
    }) as Finding[];

    const inlineComments = Array.isArray(parsed.inlineComments)
      ? parsed.inlineComments
          .map((c) => c as Record<string, unknown>)
          .filter((c) => typeof c.file === "string" && typeof c.line === "number" && typeof c.content === "string")
          .map((c) => ({
            file: c.file as string,
            line: c.line as number,
            content: c.content as string,
          }))
      : undefined;

    const summaryComment = typeof parsed.summaryComment === "string" ? parsed.summaryComment : undefined;
    const recommendation = typeof parsed.recommendation === "string" ? parsed.recommendation : undefined;

    const stats = parsed.stats && typeof parsed.stats === "object"
      ? {
          totalFindings: Number((parsed.stats as Record<string, unknown>).totalFindings ?? findings.length),
          duplicatesRemoved: (parsed.stats as Record<string, unknown>).duplicatesRemoved as number | undefined,
          bySeverity: (parsed.stats as Record<string, unknown>).bySeverity as Record<Severity, number> | undefined,
          byCategory: (parsed.stats as Record<string, unknown>).byCategory as Record<Category, number> | undefined,
        }
      : undefined;

    const rawScore = typeof parsed.codeQualityScore === "number"
      ? parsed.codeQualityScore
      : typeof parsed.confidenceScore === "number"
        ? parsed.confidenceScore
        : undefined;
    const confidenceScore = typeof rawScore === "number"
      ? Math.max(1, Math.min(5, Math.round(rawScore)))
      : undefined;

    return { findings, inlineComments, summaryComment, stats, recommendation, confidenceScore };
  } catch (error) {
    log.warn({ error }, "Failed to parse synthesis output");
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction utility
// ---------------------------------------------------------------------------

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
