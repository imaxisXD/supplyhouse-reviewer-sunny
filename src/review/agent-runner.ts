/**
 * Agent execution orchestrator — runs specialist agents in parallel,
 * handles batching, token estimation, and trace capture.
 */

import type { ReviewJob } from "../types/review.ts";
import type { Finding, AgentTrace, ToolUsageSummary } from "../types/findings.ts";
import type { ContextPackage } from "./context-builder.ts";
import type { FileDomainFacts } from "./domain-facts.ts";
import type { DegradationMode } from "../services/degradation.ts";
import {
  securityAgent,
  logicAgent,
  duplicationAgent,
  apiChangeAgent,
  refactorAgent,
  completenessAgent,
  verificationAgent,
} from "../mastra/index.ts";
import { duplicationGrepAgent } from "../agents/duplication-grep.ts";
import { openRouterBreaker } from "../services/breakers.ts";
import { runWithRepoContext } from "../tools/repo-context.ts";
import { publish } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { assertNotCancelled } from "../utils/cancellation.ts";
import { isMetaDiffLine } from "./diff-indexer.ts";
import { parseFindingsFromResponse } from "./response-parsers.ts";
import { updateStatus } from "./status-helpers.ts";

const log = createLogger("agent-runner");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentResult {
  findings: Finding[];
  traces: AgentTrace[];
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const MAX_TOKENS_PER_BATCH = 80_000;

/**
 * Rough token estimate: ~4 chars per token for code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Diff annotation
// ---------------------------------------------------------------------------

/**
 * Annotate a unified diff with pre-computed line numbers so agents don't have to count manually.
 *
 * Output format:
 *   @@ -100,10 +95,15 @@ function foo()
 *   L95:  context line (unchanged)
 *   L96: +added line
 *       : -deleted line (no new-file line number)
 *   L97:  another context line
 *
 * This eliminates manual line counting errors by agents.
 */
export function annotateDiffWithLineNumbers(diff: string): string {
  const lines = diff.split("\n");
  const annotated: string[] = [];
  let currentNewLine: number | null = null;

  const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

  for (const line of lines) {
    if (isMetaDiffLine(line)) {
      annotated.push(line);
      continue;
    }
    // File headers (---, +++)
    if (line.startsWith("---") || line.startsWith("+++")) {
      annotated.push(line);
      continue;
    }

    // Hunk headers - reset line counter
    const hunkMatch = line.match(hunkRegex);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1]!, 10);
      annotated.push(line);
      continue;
    }

    // Before first hunk (shouldn't happen in valid diff)
    if (currentNewLine === null) {
      annotated.push(line);
      continue;
    }

    // Deleted line - no new-file line number
    if (line.startsWith("-")) {
      annotated.push(`    : ${line}`);
      continue;
    }

    // Added line or context line - has new-file line number
    const lineNum = currentNewLine;
    const paddedNum = String(lineNum).padStart(4, " ");

    if (line.startsWith("+")) {
      annotated.push(`L${paddedNum}: ${line}`);
    } else {
      // Context line (space prefix or empty)
      annotated.push(`L${paddedNum}: ${line}`);
    }

    currentNewLine++;
  }

  return annotated.join("\n");
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

export function formatDomainFacts(facts?: FileDomainFacts): string {
  if (!facts) return "";
  const lines: string[] = [];
  if (facts.entities?.length) lines.push(`- Entities: ${facts.entities.join(", ")}`);
  if (facts.services?.length) lines.push(`- Services: ${facts.services.join(", ")}`);
  if (facts.templates?.length) lines.push(`- Templates: ${facts.templates.join(", ")}`);
  if (facts.scripts?.length) lines.push(`- Scripts: ${facts.scripts.join(", ")}`);
  if (facts.relations?.length) {
    for (const rel of facts.relations) {
      lines.push(`- Relation: ${rel}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a single context package into markdown for an agent prompt.
 */
export function formatContextText(
  ctx: ContextPackage,
  extras?: { prFacts?: string; plannerNotes?: string; repoDocs?: string },
): string {
  const annotatedDiff = annotateDiffWithLineNumbers(ctx.diff);
  const domainFactsText = formatDomainFacts(ctx.domainFacts);
  return (
    `## File: ${ctx.file}\n\n` +
    (extras?.prFacts ? `### PR Facts\n${extras.prFacts}\n\n` : "") +
    (extras?.plannerNotes ? `### Planner Notes\n${extras.plannerNotes}\n\n` : "") +
    (domainFactsText ? `### Domain Facts\n${domainFactsText}\n\n` : "") +
    `### Diff (with line numbers)\n\`\`\`\n${annotatedDiff}\n\`\`\`\n\n` +
    (ctx.fullFunctions.length > 0 ? `### Full Functions\n\`\`\`\n${ctx.fullFunctions.join("\n\n")}\n\`\`\`\n\n` : "") +
    (ctx.callers.length > 0 ? `### Callers\n${ctx.callers.map((c) => `- ${c.function} (${c.file}:${c.line})`).join("\n")}\n\n` : "") +
    (ctx.callees.length > 0 ? `### Callees\n${ctx.callees.map((c) => `- ${c.function} (${c.file}:${c.line})`).join("\n")}\n\n` : "") +
    (ctx.similarCode.length > 0 ? `### Similar Code\n${ctx.similarCode.map((s) => `- ${s.function} (${s.file}, ${Math.round(s.similarity * 100)}% similar)`).join("\n")}\n\n` : "") +
    (ctx.usages.length > 0 ? `### Usages\n${ctx.usages.map((u) => `- ${u.file}:${u.line} ${u.content}`).join("\n")}\n\n` : "")
  );
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/**
 * Split context packages into batches that fit within the token budget.
 */
export function batchContextPackages(
  packages: ContextPackage[],
  extras?: { prFacts?: string; plannerNotes?: string; repoDocs?: string },
): ContextPackage[][] {
  const batches: ContextPackage[][] = [];
  let currentBatch: ContextPackage[] = [];
  const fixedTokens = extras?.repoDocs ? estimateTokens(`### Repo Docs\n${extras.repoDocs}`) : 0;
  let currentTokens = fixedTokens;

  for (const pkg of packages) {
    const text = formatContextText(pkg, extras);
    const tokens = estimateTokens(text);

    // If a single file exceeds the budget, give it its own batch
    if (tokens >= MAX_TOKENS_PER_BATCH) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = fixedTokens;
      }
      batches.push([pkg]);
      continue;
    }

    if (currentTokens + tokens > MAX_TOKENS_PER_BATCH && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = fixedTokens;
    }

    currentBatch.push(pkg);
    currentTokens += tokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches.length > 0 ? batches : [[]];
}

// ---------------------------------------------------------------------------
// Result extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract usage metrics (tokens, cost, generationId) from an agent result.
 * Shared by all agent call sites to avoid duplicating cost-extraction logic.
 */
export function extractUsageFromResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
): { inputTokens: number; outputTokens: number; costUsd: number; generationId?: string } {
  const usage = (result as Record<string, unknown>).usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.promptTokens === "number" ? usage.promptTokens : 0;
  const outputTokens = typeof usage?.completionTokens === "number" ? usage.completionTokens : 0;
  const directCost = typeof usage?.cost === "number" ? usage.cost : null;
  const generationId = result.response?.id;
  return {
    inputTokens,
    outputTokens,
    costUsd: directCost ?? 0,
    generationId: generationId || undefined,
  };
}

/**
 * Extract tool usage from agent execution steps.
 * The AI SDK result exposes `steps`, each with `toolCalls` arrays.
 * Defensively checks both direct properties and payload wrappers
 * to handle AI SDK vs Mastra wrapping differences.
 */
export function extractToolUsageFromResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
): ToolUsageSummary {
  const byTool: Record<string, number> = {};
  let totalCalls = 0;

  const steps = result?.steps;
  if (!Array.isArray(steps)) {
    return { totalCalls: 0, byTool };
  }

  for (const step of steps) {
    const toolCalls = step?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;

    for (const call of toolCalls) {
      // AI SDK uses call.toolName; Mastra chunk wrapper uses call.payload.toolName
      const toolName: string = call?.toolName ?? call?.payload?.toolName ?? "unknown";
      byTool[toolName] = (byTool[toolName] ?? 0) + 1;
      totalCalls++;
    }
  }

  return { totalCalls, byTool };
}

export function buildSkippedTrace(agent: string): AgentTrace {
  const now = new Date().toISOString();
  return {
    agent,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    findingsCount: 0,
    status: "skipped",
  };
}

// ---------------------------------------------------------------------------
// Single agent execution
// ---------------------------------------------------------------------------

/**
 * Run a single agent with timing and token usage capture.
 */
export async function runSingleAgentWithTrace(
  agentName: string,
  reviewId: string,
  prompt: string,
  repoContext: { repoId: string; repoPath: string },
  promptContext?: { hasRepoDocsContext: boolean; hasRepoDocsExcerpts: boolean },
): Promise<{ findings: Finding[]; trace: AgentTrace }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agents: Record<string, { generate: (prompt: string, options?: any) => Promise<any> }> = {
    "security": securityAgent,
    "logic": logicAgent,
    "duplication": duplicationAgent,
    "duplication-grep": duplicationGrepAgent,
    "api-change": apiChangeAgent,
    "refactor": refactorAgent,
    "completeness": completenessAgent,
    "verification": verificationAgent,
  };

  const agent = agents[agentName];
  if (!agent) {
    return { findings: [], trace: buildSkippedTrace(agentName) };
  }

  const startedAt = new Date();
  log.info(
    {
      reviewId,
      agent: agentName,
      docsContextIncluded: promptContext?.hasRepoDocsContext ?? false,
      docsExcerptsIncluded: promptContext?.hasRepoDocsExcerpts ?? false,
    },
    "Running agent with prompt context",
  );

  try {
    const result = await openRouterBreaker.execute(async () => {
      return runWithRepoContext(repoContext, () => agent.generate(prompt, { tracingOptions: { metadata: { reviewId } } }));
    });

    const completedAt = new Date();
    const text = typeof result.text === "string" ? result.text : "";
    const allFindings = parseFindingsFromResponse(text, agentName);
    const usage = extractUsageFromResult(result);
    const toolUsage = extractToolUsageFromResult(result);

    // Confidence gate: drop low-confidence findings that lack investigation trail
    const findings = allFindings.filter(f => {
      if (f.confidence < 0.7 && !f.investigation) {
        log.warn(
          { reviewId, agent: agentName, title: f.title, confidence: f.confidence },
          "Dropping low-confidence finding without investigation trail",
        );
        return false;
      }
      return true;
    });

    log.info(
      { reviewId, agent: agentName, toolsUsed: toolUsage.totalCalls, byTool: toolUsage.byTool, ...usage },
      "Agent execution complete",
    );

    return {
      findings,
      trace: {
        agent: agentName,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...usage,
        findingsCount: findings.length,
        status: "success",
        toolUsage,
      },
    };
  } catch (error) {
    const completedAt = new Date();
    log.error(
      { reviewId, agent: agentName, error: error instanceof Error ? error.message : String(error) },
      "Agent execution failed",
    );
    return {
      findings: [],
      trace: {
        agent: agentName,
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

// ---------------------------------------------------------------------------
// Multi-agent orchestration
// ---------------------------------------------------------------------------

/**
 * Run all specialist agents in parallel and collect their findings.
 * Respects degradation modes: skips agents that depend on unavailable services.
 * For large PRs, files are batched and agents are run per batch to stay within token limits.
 */
export async function runAgents(
  reviewId: string,
  contextPackages: ContextPackage[],
  degradation: DegradationMode,
  job: ReviewJob,
  repoContext: { repoId: string; repoPath: string },
  cancelKey: string,
  hasEmbeddings: boolean,
  extras?: { prFacts?: string; plannerNotes?: string; repoDocs?: string },
): Promise<AgentResult> {
  await assertNotCancelled(cancelKey, "Review cancelled");
  const options = job.options || {};
  const hasRepoDocsContext = Boolean(extras?.repoDocs);
  const hasRepoDocsExcerpts = Boolean(extras?.repoDocs?.includes("#### Relevant Excerpts"));

  const batches = batchContextPackages(contextPackages, extras);
  log.info(
    {
      reviewId,
      batchCount: batches.length,
      totalFiles: contextPackages.length,
      hasRepoDocsContext,
      hasRepoDocsExcerpts,
    },
    "Context batched for agents",
  );

  const allFindings: Finding[] = [];
  const allTraces: AgentTrace[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    if (batch.length === 0) continue;
    await assertNotCancelled(cancelKey, "Review cancelled");

    const contextText = batch.map((pkg) => formatContextText(pkg, extras)).join("\n---\n\n");
    const batchLabel = batches.length > 1 ? ` (batch ${batchIdx + 1}/${batches.length})` : "";
    const repoDocsText = extras?.repoDocs ? `\n\n### Repo Docs\n${extras.repoDocs}\n` : "";
    const prompt = `Review the following code changes and provide your findings.${batchLabel}

**CRITICAL — Line number extraction (MUST FOLLOW):**
Each diff line is prefixed with its line number like this:
  L  45: +const foo = bar;   ← Line 45, added line
  L  46:  existing code      ← Line 46, context line
      : -deleted line        ← Deleted line (no line number)

**For EVERY finding you MUST:**
1. Find the exact line in the diff that has the issue
2. Extract the number after "L" (e.g., "L  45:" means line 45)
3. Include "line": 45 in your finding JSON (NOT "line": 0, NOT omitting it)

**Findings WITHOUT valid line numbers will be DISCARDED and not posted to the PR.**

Example: If you see "L 123: +db.query(\`SELECT * FROM \${userId}\`)" and find SQL injection:
→ Report: { "file": "...", "line": 123, "lineId": "L123", "lineText": "+db.query(...)", ... }
${repoDocsText}
${contextText}`;

    type AgentTask = { name: string; promise: Promise<{ findings: Finding[]; trace: AgentTrace }> };
    const agentTasks: AgentTask[] = [];
    const batchTraces: AgentTrace[] = [];
    const runningAgents: string[] = [];

    // Security agent - always runs unless LLM is completely down or skipped
    if (!degradation.slowLlm && !options.skipSecurity) {
      await assertNotCancelled(cancelKey, "Review cancelled");
      agentTasks.push({
        name: "security",
        promise: runSingleAgentWithTrace("security", reviewId, prompt, repoContext, { hasRepoDocsContext, hasRepoDocsExcerpts }),
      });
      runningAgents.push("security");
    } else if (batchIdx === 0) {
      batchTraces.push(buildSkippedTrace("security"));
    }

    // Logic agent - always runs unless LLM is completely down
    if (!degradation.slowLlm) {
      await assertNotCancelled(cancelKey, "Review cancelled");
      agentTasks.push({
        name: "logic",
        promise: runSingleAgentWithTrace("logic", reviewId, prompt, repoContext, { hasRepoDocsContext, hasRepoDocsExcerpts }),
      });
      runningAgents.push("logic");
    } else if (batchIdx === 0) {
      batchTraces.push(buildSkippedTrace("logic"));
    }

    // Duplication agent - uses embeddings if available, falls back to grep
    if (!options.skipDuplication && !degradation.slowLlm) {
      await assertNotCancelled(cancelKey, "Review cancelled");
      // Use embedding-based agent if embeddings are available, otherwise grep-based
      const duplicationAgentId = hasEmbeddings ? "duplication" : "duplication-grep";
      if (batchIdx === 0) {
        log.info({ reviewId, hasEmbeddings, agentId: duplicationAgentId }, "Running duplication agent");
      }
      agentTasks.push({
        name: "duplication",
        promise: runSingleAgentWithTrace(duplicationAgentId, reviewId, prompt, repoContext, { hasRepoDocsContext, hasRepoDocsExcerpts }),
      });
      runningAgents.push("duplication");
    } else if (batchIdx === 0) {
      if (options.skipDuplication) {
        log.info({ reviewId }, "Skipping duplication agent (disabled by user)");
      }
      batchTraces.push(buildSkippedTrace("duplication"));
    }

    // API change agent - benefits from graph but can work without
    if (!degradation.slowLlm && !degradation.noGraph) {
      await assertNotCancelled(cancelKey, "Review cancelled");
      agentTasks.push({
        name: "api-change",
        promise: runSingleAgentWithTrace("api-change", reviewId, prompt, repoContext, { hasRepoDocsContext, hasRepoDocsExcerpts }),
      });
      runningAgents.push("api-change");
    } else if (batchIdx === 0) {
      if (degradation.noGraph) {
        log.info({ reviewId }, "Skipping api-change agent (graph unavailable)");
      }
      batchTraces.push(buildSkippedTrace("api-change"));
    }

    // Refactor agent - always runs
    if (!degradation.slowLlm) {
      await assertNotCancelled(cancelKey, "Review cancelled");
      agentTasks.push({
        name: "refactor",
        promise: runSingleAgentWithTrace("refactor", reviewId, prompt, repoContext, { hasRepoDocsContext, hasRepoDocsExcerpts }),
      });
      runningAgents.push("refactor");
    } else if (batchIdx === 0) {
      batchTraces.push(buildSkippedTrace("refactor"));
    }

    // Completeness agent - finds MISSING controls (CSRF, rate limiting, validation)
    if (!degradation.slowLlm) {
      await assertNotCancelled(cancelKey, "Review cancelled");
      agentTasks.push({
        name: "completeness",
        promise: runSingleAgentWithTrace("completeness", reviewId, prompt, repoContext, { hasRepoDocsContext, hasRepoDocsExcerpts }),
      });
      runningAgents.push("completeness");
    } else if (batchIdx === 0) {
      batchTraces.push(buildSkippedTrace("completeness"));
    }

    if (runningAgents.length > 0) {
      await updateStatus(reviewId, "running-agents", 45, [], undefined, undefined, [...runningAgents]);
    }

    const results = await Promise.allSettled(agentTasks.map((t) => t.promise));
    await assertNotCancelled(cancelKey, "Review cancelled");

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const taskName = agentTasks[i]!.name;
      const idx = runningAgents.indexOf(taskName);
      if (idx >= 0) {
        runningAgents.splice(idx, 1);
        await updateStatus(reviewId, "running-agents", 45, [], undefined, undefined, [...runningAgents]);
      }

      if (result.status === "fulfilled") {
        allFindings.push(...result.value.findings);
        batchTraces.push(result.value.trace);

        // Publish per-agent completion event
        await publish(`review:events:${reviewId}`, {
          type: "AGENT_COMPLETE",
          agent: taskName,
          findingsCount: result.value.findings.length,
          durationMs: result.value.trace.durationMs,
          mastraTraceId: result.value.trace.mastraTraceId,
        });

        // Publish individual finding events
        for (const finding of result.value.findings) {
          await publish(`review:events:${reviewId}`, {
            type: "FINDING_ADDED",
            finding: {
              file: finding.file,
              line: finding.line,
              severity: finding.severity,
              title: finding.title,
              agent: taskName,
            },
          });
        }
      } else {
        log.warn({ agent: taskName, error: result.reason }, "Agent failed, continuing with other agents");
        batchTraces.push({
          agent: taskName,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          findingsCount: 0,
          status: "failed",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    allTraces.push(...batchTraces);
  } // end batch loop

  return { findings: allFindings, traces: allTraces };
}
