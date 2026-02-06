/**
 * Planner agent phase — runs before specialist agents to produce
 * a high-level summary and focus hints for the review.
 */

import type { DiffFile } from "../types/bitbucket.ts";
import type { AgentTrace } from "../types/findings.ts";
import type { ContextPackage } from "./context-builder.ts";
import type { FileDomainFacts, PrDomainFacts } from "./domain-facts.ts";
import { buildDiffIndex, buildSummaryDiff } from "./diff-indexer.ts";
import { plannerAgent } from "../mastra/index.ts";
import { openRouterBreaker } from "../services/breakers.ts";
import { createLogger } from "../config/logger.ts";
import { parsePlannerOutput, type PlannerOutput } from "./response-parsers.ts";
import { extractUsageFromResult } from "./agent-runner.ts";

const log = createLogger("planner-phase");

// ---------------------------------------------------------------------------
// Summary-only context helpers
// ---------------------------------------------------------------------------

const SUMMARY_DIFF_MAX_LINES = 200;
const SUMMARY_CONTEXT_LINES = 3;

export function buildSummaryContext(diffFile: DiffFile, domainFacts?: FileDomainFacts): ContextPackage {
  return {
    file: diffFile.path,
    diff: buildSummaryDiff(diffFile, { maxLines: SUMMARY_DIFF_MAX_LINES, contextLines: SUMMARY_CONTEXT_LINES }),
    fullFunctions: [],
    callers: [],
    callees: [],
    similarCode: [],
    usages: [],
    domainFacts,
  };
}

// ---------------------------------------------------------------------------
// PR facts formatting
// ---------------------------------------------------------------------------

export function formatPrFacts(diffIndex: ReturnType<typeof buildDiffIndex>, diffFiles: DiffFile[]): string {
  const lines: string[] = [];
  const moveFacts = diffIndex.moveFacts;
  if (moveFacts.length > 0) {
    for (const fact of moveFacts.slice(0, 10)) {
      lines.push(
        `- Moved block: ${fact.from.file}:${fact.from.startLine}-${fact.from.endLine} → ${fact.to.file}:${fact.to.startLine}-${fact.to.endLine} (${fact.sizeLines} lines)`,
      );
    }
    if (moveFacts.length > 10) {
      lines.push(`- ...and ${moveFacts.length - 10} more moved blocks`);
    }
  }

  for (const file of diffFiles) {
    if (file.status === "renamed" && file.oldPath) {
      lines.push(`- Renamed file: ${file.oldPath} → ${file.path}`);
    }
  }

  if (lines.length === 0) {
    lines.push("- No special PR facts detected");
  }

  return lines.join("\n");
}

export function formatPrDomainFacts(facts: PrDomainFacts): string {
  const lines: string[] = [];
  if (facts.entities?.length) lines.push(`- Entities touched: ${facts.entities.join(", ")}`);
  if (facts.services?.length) lines.push(`- Services touched: ${facts.services.join(", ")}`);
  if (facts.templates?.length) lines.push(`- Templates touched: ${facts.templates.join(", ")}`);
  if (facts.scripts?.length) lines.push(`- Scripts touched: ${facts.scripts.join(", ")}`);
  if (facts.relations?.length) {
    for (const rel of facts.relations) {
      lines.push(`- Relation: ${rel}`);
    }
  }
  return lines.join("\n");
}

export function formatPlannerNotes(planner: PlannerOutput | null): string {
  if (!planner) return "";
  const lines: string[] = [];
  if (planner.summary) lines.push(`Summary: ${planner.summary}`);
  if (planner.focusFiles?.length) lines.push(`Focus files: ${planner.focusFiles.join(", ")}`);
  if (planner.moveNotes?.length) lines.push(`Move notes: ${planner.moveNotes.join("; ")}`);
  if (planner.riskNotes?.length) lines.push(`Risk notes: ${planner.riskNotes.join("; ")}`);
  if (planner.agentHints?.length) lines.push(`Agent hints: ${planner.agentHints.join("; ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Planner agent execution
// ---------------------------------------------------------------------------

export async function runPlannerAgent(
  reviewId: string,
  diffFiles: DiffFile[],
  diffIndex: ReturnType<typeof buildDiffIndex>,
  prDomainFactsText?: string,
): Promise<{ output: PlannerOutput | null; trace: AgentTrace }> {
  const startedAt = new Date();
  const fileLines = diffFiles.map((f) =>
    `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}${f.oldPath ? `, renamed from ${f.oldPath}` : ""})`,
  );

  const summaryDiffs: string[] = [];
  for (const diffFile of diffFiles) {
    const summaryDiff = buildSummaryDiff(diffFile, { maxLines: SUMMARY_DIFF_MAX_LINES, contextLines: SUMMARY_CONTEXT_LINES });
    summaryDiffs.push(`## File: ${diffFile.path}\n\`\`\`\n${summaryDiff}\n\`\`\``);
  }

  const moveFactsText = formatPrFacts(diffIndex, diffFiles);

  const prompt = [
    "You are planning a code review. Summarize key PR facts for downstream agents.",
    "",
    "## Files Changed",
    ...fileLines,
    "",
    "## PR Facts",
    moveFactsText,
    "",
    ...(prDomainFactsText ? ["## PR Domain Facts", prDomainFactsText, ""] : []),
    "## Summary Diffs",
    summaryDiffs.join("\n\n"),
  ].join("\n");

  try {
    const result = await openRouterBreaker.execute(async () => plannerAgent.generate(prompt, { tracingOptions: { metadata: { reviewId } } }));
    const completedAt = new Date();
    const text = typeof result.text === "string" ? result.text : "";
    const usage = extractUsageFromResult(result);
    return {
      output: parsePlannerOutput(text),
      trace: {
        agent: "planner",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...usage,
        findingsCount: 0,
        status: "success",
      },
    };
  } catch (error) {
    const completedAt = new Date();
    log.warn(
      { reviewId, error: error instanceof Error ? error.message : String(error) },
      "Planner agent failed; continuing without planner notes",
    );
    return {
      output: null,
      trace: {
        agent: "planner",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        findingsCount: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
