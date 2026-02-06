/**
 * Synthesis phase — uses the synthesis agent to deduplicate,
 * rank, and produce the final findings list + summary comment.
 */

import type { Finding, AgentTrace } from "../types/findings.ts";
import type { DegradationMode } from "../services/degradation.ts";
import { synthesisAgent } from "../mastra/index.ts";
import { openRouterBreaker } from "../services/breakers.ts";
import { createLogger } from "../config/logger.ts";
import { parseSynthesisOutput, type SynthesisOutput } from "./response-parsers.ts";
import { extractUsageFromResult, extractToolUsageFromResult } from "./agent-runner.ts";
import { runWithRepoContext } from "../tools/repo-context.ts";

const log = createLogger("synthesis-phase");

export type { SynthesisOutput };

export async function synthesizeFindings(
  reviewId: string,
  findings: Finding[],
  degradation: DegradationMode,
  prTitle?: string,
  prDescription?: string,
  diffFilesMeta?: { path: string; status: string; additions: number; deletions: number }[],
  repoContext?: { repoId: string; repoPath: string },
): Promise<SynthesisOutput & { trace?: AgentTrace }> {
  if (findings.length === 0) return { findings: [], confidenceScore: 5 };

  // If LLM is degraded, skip synthesis and return raw findings
  if (degradation.slowLlm) {
    log.info({ reviewId }, "Skipping synthesis (LLM degraded), returning raw findings");
    return { findings };
  }

  const startedAt = new Date();
  try {
    const promptParts: string[] = [];

    if (prTitle || prDescription) {
      promptParts.push("## PR Information");
      if (prTitle) promptParts.push(`**Title:** ${prTitle}`);
      if (prDescription) promptParts.push(`**Description:** ${prDescription}`);
      promptParts.push("");
    }

    if (diffFilesMeta && diffFilesMeta.length > 0) {
      promptParts.push("## Files Changed");
      for (const f of diffFilesMeta) {
        promptParts.push(`- \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions})`);
      }
      promptParts.push("");
    }

    promptParts.push("## Findings from Specialist Agents");
    promptParts.push("");
    promptParts.push("Synthesize and deduplicate the following findings:");
    promptParts.push("");
    promptParts.push(JSON.stringify(findings, null, 2));

    const prompt = promptParts.join("\n");

    const generateFn = () => synthesisAgent.generate(prompt, { tracingOptions: { metadata: { reviewId } } });
    const result = await openRouterBreaker.execute(async () => {
      return repoContext
        ? runWithRepoContext(repoContext, generateFn)
        : generateFn();
    });
    const completedAt = new Date();
    const usage = extractUsageFromResult(result);
    const toolUsage = extractToolUsageFromResult(result);

    log.info(
      { reviewId, agent: "synthesis", toolsUsed: toolUsage.totalCalls, byTool: toolUsage.byTool },
      "Synthesis agent execution complete",
    );

    const trace: AgentTrace = {
      agent: "synthesis",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...usage,
      findingsCount: 0,
      status: "success",
      toolUsage,
    };

    const text = typeof result.text === "string" ? result.text : "";
    const synthesized = parseSynthesisOutput(text);
    if (synthesized && synthesized.findings.length > 0) return { ...synthesized, trace };
    return { findings, trace };
  } catch (error) {
    const completedAt = new Date();
    log.warn({ reviewId, error }, "Synthesis failed, returning raw findings");
    return {
      findings,
      trace: {
        agent: "synthesis",
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
