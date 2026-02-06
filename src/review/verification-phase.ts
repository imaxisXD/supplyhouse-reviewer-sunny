/**
 * Verification phase — runs the verification agent to disprove
 * false positives from the specialist agents.
 */

import type { Finding, AgentTrace } from "../types/findings.ts";
import { verificationAgent } from "../mastra/index.ts";
import { openRouterBreaker } from "../services/breakers.ts";
import { runWithRepoContext } from "../tools/repo-context.ts";
import { createLogger } from "../config/logger.ts";
import { assertNotCancelled } from "../utils/cancellation.ts";
import { parseVerificationResponse } from "./response-parsers.ts";
import { extractUsageFromResult } from "./agent-runner.ts";

const log = createLogger("verification-phase");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  verifiedFindings: Finding[];
  disprovenFindings: Finding[];
  disprovenCount: number;
  traces: AgentTrace[];
}

// ---------------------------------------------------------------------------
// Verification execution
// ---------------------------------------------------------------------------

/**
 * Run the verification phase to disprove false positives.
 * Uses the verification agent to semantically analyze findings and determine
 * if they're actually exploitable.
 */
export async function runVerificationPhase(
  reviewId: string,
  findings: Finding[],
  repoContext: { repoId: string; repoPath: string },
  cancelKey: string,
): Promise<VerificationResult> {
  // Batch findings for efficiency (max 10 per batch)
  const BATCH_SIZE = 10;
  const batches: Finding[][] = [];

  for (let i = 0; i < findings.length; i += BATCH_SIZE) {
    batches.push(findings.slice(i, i + BATCH_SIZE));
  }

  const verifiedFindings: Finding[] = [];
  const disprovenFindings: Finding[] = [];
  const batchTraces: AgentTrace[] = [];
  let disprovenCount = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    await assertNotCancelled(cancelKey, "Review cancelled");
    const startedAt = new Date();

    const prompt = `
You are verifying the following findings from a code review.
For each finding, investigate whether it's actually exploitable or a false positive.

## Findings to Verify

${JSON.stringify(batch, null, 2)}

## Instructions

1. For each finding, use your tools to trace data flow and verify if:
   - The data source is actually user-controlled (USER_INPUT)
   - There's no sanitization/validation between source and sink
   - The vulnerability is actually exploitable

2. Return your verification results in JSON format.

IMPORTANT: Be skeptical. Many security findings are false positives because:
- The data comes from server-side context, not user input
- There's sanitization/validation you need to find
- The framework provides automatic protection

Return format:
\`\`\`json
{
  "verifiedFindings": [
    { /* original finding with verificationNotes field added */ }
  ],
  "disprovenFindings": [
    {
      "originalFinding": { /* the original finding */ },
      "disprovalReason": "Explanation of why this is a false positive"
    }
  ]
}
\`\`\`
`;

    try {
      const result = await openRouterBreaker.execute(async () => {
        return runWithRepoContext(repoContext, () => verificationAgent.generate(prompt, { tracingOptions: { metadata: { reviewId } } }));
      });
      const completedAt = new Date();

      const text = typeof result.text === "string" ? result.text : "";
      const parsed = parseVerificationResponse(text, batch);
      const usage = extractUsageFromResult(result);

      verifiedFindings.push(...parsed.verified);
      disprovenFindings.push(...parsed.disproven);
      disprovenCount += parsed.disprovenCount;

      batchTraces.push({
        agent: batches.length > 1 ? `verification-${batchIdx + 1}` : "verification",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...usage,
        findingsCount: parsed.verified.length + parsed.disproven.length,
        status: "success",
      });
    } catch (error) {
      const completedAt = new Date();
      log.warn(
        { reviewId, error: error instanceof Error ? error.message : String(error) },
        "Verification batch failed, keeping original findings",
      );
      // If verification fails, keep original findings
      verifiedFindings.push(...batch);

      batchTraces.push({
        agent: batches.length > 1 ? `verification-${batchIdx + 1}` : "verification",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        findingsCount: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { verifiedFindings, disprovenFindings, disprovenCount, traces: batchTraces };
}
