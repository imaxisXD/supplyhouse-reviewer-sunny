import type { ReviewJob, ReviewStatus, ReviewPhase } from "../types/review.ts";
import type { Finding, ReviewResult, Severity, Category, AgentTrace } from "../types/findings.ts";
import type { ContextPackage } from "./context-builder.ts";
import type { DiffFile } from "../types/bitbucket.ts";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { bitbucketClient } from "../bitbucket/client.ts";
import { parseDiff, mapDiffLineToFileLine } from "../bitbucket/diff-parser.ts";
import { buildContext } from "./context-builder.ts";
import { prioritizeFiles } from "./large-pr.ts";
import { redis, publish } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { env } from "../config/env.ts";
import { bitbucketBreaker, openRouterBreaker } from "../services/breakers.ts";
import { getDegradationMode } from "../services/degradation.ts";
import { MODELS, calculateCost } from "../mastra/models.ts";
import {
  securityAgent,
  logicAgent,
  duplicationAgent,
  apiChangeAgent,
  refactorAgent,
  synthesisAgent,
} from "../mastra/index.ts";
import { runWithRepoContext } from "../tools/repo-context.ts";
import { repoIdFromSlug } from "../utils/repo-identity.ts";
import { fetchToken } from "../utils/token-store.ts";
import { assertNotCancelled, isCancelled, reviewCancelKey } from "../utils/cancellation.ts";

const log = createLogger("review-workflow");
const CLONE_BASE_DIR = process.env.CLONE_DIR || "/tmp/supplyhouse-repos";

// ---------------------------------------------------------------------------
// Clone helper
// ---------------------------------------------------------------------------

async function cloneRepoForReview(
  workspace: string,
  repoSlug: string,
  branch: string,
  token: string,
): Promise<string> {
  fs.mkdirSync(CLONE_BASE_DIR, { recursive: true });
  const cloneDir = path.join(CLONE_BASE_DIR, `review_${randomUUID()}`);
  const repoUrl = `https://bitbucket.org/${workspace}/${repoSlug}.git`;

  let authUrl = repoUrl;
  if (token) {
    const url = new URL(repoUrl);
    url.username = "x-token-auth";
    url.password = token;
    authUrl = url.toString();
  }

  log.info({ workspace, repoSlug, branch, cloneDir }, "Cloning repository for review");

  const proc = Bun.spawn(
    ["git", "clone", "--depth", "1", "--branch", branch, authUrl, cloneDir],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const sanitized = stderr.replace(/x-token-auth:[^@]+@/g, "x-token-auth:***@");
    throw new Error(`git clone failed (exit ${exitCode}): ${sanitized}`);
  }

  return cloneDir;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

async function updateStatus(
  reviewId: string,
  phase: ReviewPhase,
  percentage: number,
  findings: Finding[] = [],
  error?: string,
  currentFile?: string,
  agentsRunning?: string[],
): Promise<void> {
  const status: ReviewStatus = {
    id: reviewId,
    phase,
    percentage,
    findings,
    findingsCount: findings.length,
    startedAt: new Date().toISOString(),
    currentFile,
    agentsRunning,
    ...(error ? { error } : {}),
    ...(phase === "complete" || phase === "failed" ? { completedAt: new Date().toISOString() } : {}),
  };

  const existingRaw = await redis.get(`review:${reviewId}`);
  let existingPhase: ReviewPhase | undefined;
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as Record<string, unknown>;
      if (typeof existing.phase === "string") {
        existingPhase = existing.phase as ReviewPhase;
      }
      if (typeof existing.startedAt === "string") {
        status.startedAt = existing.startedAt;
      }
      if (currentFile === undefined && typeof existing.currentFile === "string") {
        status.currentFile = existing.currentFile as string;
      }
      if (agentsRunning === undefined && Array.isArray(existing.agentsRunning)) {
        status.agentsRunning = existing.agentsRunning as string[];
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (existingPhase === "complete") {
    return;
  }
  if (existingPhase === "failed" && phase === "failed") {
    return;
  }
  if (existingPhase === "failed" && phase !== "failed") {
    return;
  }

  if (phase !== "running-agents") {
    status.agentsRunning = [];
  }

  await redis.set(`review:${reviewId}`, JSON.stringify(status));

  if (phase === "failed") {
    await publish(`review:events:${reviewId}`, {
      type: "REVIEW_FAILED",
      error: error ?? "Review failed",
    });
    return;
  }

  await publish(`review:events:${reviewId}`, {
    type: "PHASE_CHANGE",
    phase,
    percentage,
    findingsCount: findings.length,
    ...(currentFile ? { currentFile } : {}),
    ...(agentsRunning ? { agentsRunning } : {}),
    ...(error ? { error } : {}),
  });
}

// ---------------------------------------------------------------------------
// Review execution
// ---------------------------------------------------------------------------

export async function executeReview(job: ReviewJob): Promise<ReviewResult> {
  const { id: reviewId, workspace, repoSlug, prNumber } = job;

  // Idempotency guard: if a result already exists (e.g. BullMQ retry after partial success),
  // return it instead of re-running the entire review and re-posting comments.
  const existingResult = await redis.get(`review:result:${reviewId}`);
  if (existingResult) {
    log.info({ reviewId }, "Review result already exists, returning cached result (idempotency guard)");
    return JSON.parse(existingResult) as ReviewResult;
  }

  const startTime = Date.now();
  const degradation = getDegradationMode();
  let repoPath = "";
  let token: string | undefined;
  const cancelKey = reviewCancelKey(reviewId);

  log.info({ reviewId, workspace, repoSlug, prNumber, degradation }, "Starting review");

  try {
    if (job.tokenKey) {
      token = await fetchToken(job.tokenKey) ?? undefined;
    }
    if (!token) {
      throw new Error("Bitbucket token not available for review job");
    }
    if (!env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is required to run reviews");
    }
    await assertNotCancelled(cancelKey, "Review cancelled");
    const tokenValue = token;
    // ------------------------------------------------------------------
    // Step 1: Fetch PR diff
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "fetching-pr", 5);
    await assertNotCancelled(cancelKey, "Review cancelled");

    const rawDiff = await bitbucketBreaker.execute(() =>
      bitbucketClient.getPRDiff(workspace, repoSlug, prNumber, tokenValue),
    );

    // ------------------------------------------------------------------
    // Step 2: Parse diff + prioritize files
    // ------------------------------------------------------------------
    const diffFiles = parseDiff(rawDiff);
    const prioritized = prioritizeFiles(diffFiles, job.options?.priorityFiles);
    const fullAnalysisFiles = prioritized.filter((f) => f.fullAnalysis).map((f) => f.file);
    const summaryOnlyFiles = prioritized.filter((f) => !f.fullAnalysis).map((f) => f.file);
    const droppedFiles = diffFiles.length - prioritized.length;

    // Step 2.5: Resolve PR source branch + clone repository
    let branch = job.branch;
    let sourceWorkspace = job.sourceWorkspace;
    let sourceRepoSlug = job.sourceRepoSlug;

    if (!branch || !sourceWorkspace || !sourceRepoSlug) {
      try {
        const prDetails = await bitbucketBreaker.execute(() =>
          bitbucketClient.getPRDetails(workspace, repoSlug, prNumber, tokenValue),
        );
        branch = branch || prDetails.sourceBranch || prDetails.targetBranch || "main";
        sourceWorkspace = sourceWorkspace || prDetails.sourceWorkspace;
        sourceRepoSlug = sourceRepoSlug || prDetails.sourceRepoSlug;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn({ reviewId, error: msg }, "Failed to fetch PR details; defaulting to main branch");
        branch = branch || "main";
      }
    }
    const cloneWorkspace = sourceWorkspace || workspace;
    const cloneRepoSlug = sourceRepoSlug || repoSlug;
    repoPath = await cloneRepoForReview(cloneWorkspace, cloneRepoSlug, branch, tokenValue);
    await updateStatus(reviewId, "fetching-pr", 15);
    await assertNotCancelled(cancelKey, "Review cancelled");

    log.info(
      {
        reviewId,
        totalFiles: diffFiles.length,
        fullAnalysis: fullAnalysisFiles.length,
        summaryOnly: summaryOnlyFiles.length,
        dropped: droppedFiles,
      },
      "Diff parsed and files prioritized",
    );

    // ------------------------------------------------------------------
    // Step 3: Build context
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "building-context", 20);
    await assertNotCancelled(cancelKey, "Review cancelled");

    const repoId = repoIdFromSlug(workspace, repoSlug);

    const fullContextPackages = await buildContext(
      repoId,
      fullAnalysisFiles,
      repoPath,
      async (filePath, index, total) => {
        await assertNotCancelled(cancelKey, "Review cancelled");
        const progress = 20 + Math.round((index / Math.max(total, 1)) * 20);
        await updateStatus(reviewId, "building-context", progress, [], undefined, filePath);
      },
      {
        skipGraph: degradation.noGraph,
        skipVectors: degradation.noVectors || degradation.noEmbeddings,
      },
    );
    const summaryContextPackages = summaryOnlyFiles.map((file) => buildSummaryContext(file));
    const fullByPath = new Map(fullContextPackages.map((pkg) => [pkg.file, pkg]));
    const summaryByPath = new Map(summaryContextPackages.map((pkg) => [pkg.file, pkg]));
    const contextPackages = prioritized
      .map((entry) => fullByPath.get(entry.file.path) ?? summaryByPath.get(entry.file.path))
      .filter((pkg): pkg is ContextPackage => Boolean(pkg));
    await updateStatus(reviewId, "building-context", 40);
    await assertNotCancelled(cancelKey, "Review cancelled");

    // ------------------------------------------------------------------
    // Step 4: Run agents
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "running-agents", 45);
    await assertNotCancelled(cancelKey, "Review cancelled");
    log.info({ reviewId }, "Running analysis agents");

    const { findings: agentFindings, traces } = await runAgents(
      reviewId,
      contextPackages,
      degradation,
      job,
      { repoId, repoPath },
      cancelKey,
    );
    await updateStatus(reviewId, "running-agents", 70, agentFindings);

    // ------------------------------------------------------------------
    // Step 5: Synthesize results
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "synthesizing", 75, agentFindings);
    await assertNotCancelled(cancelKey, "Review cancelled");
    const synthesis = await synthesizeFindings(reviewId, agentFindings, degradation);
    const findings = synthesis.findings;

    const durationMs = Date.now() - startTime;
    const totalCostUsd = traces.reduce((sum, t) => sum + t.costUsd, 0);
    const summary = buildSummary(findings, contextPackages.length, durationMs, totalCostUsd);

    await updateStatus(reviewId, "synthesizing", 85, findings);

    // ------------------------------------------------------------------
    // Step 6: Post comments to BitBucket
    // ------------------------------------------------------------------
    let commentsPosted: ReviewResult["commentsPosted"] = [];
    const cancelled = await isCancelled(cancelKey);
    if (degradation.noBitbucket) {
      log.info({ reviewId }, "Skipping comment posting (Bitbucket unavailable)");
    } else if (cancelled) {
      log.info({ reviewId }, "Skipping comment posting (review cancelled)");
    } else {
      await updateStatus(reviewId, "posting-comments", 90, findings);
      commentsPosted = await postFindings(
        workspace, repoSlug, prNumber, tokenValue, findings, summary,
        synthesis, repoPath, diffFiles, cancelKey,
      );
    }

    // ------------------------------------------------------------------
    // Step 7: Store result and mark complete
    // ------------------------------------------------------------------
    const result: ReviewResult = {
      findings,
      summary,
      commentsPosted,
      traces,
      prUrl: job.prUrl,
      synthesis: {
        inlineComments: synthesis.inlineComments,
        summaryComment: synthesis.summaryComment,
        stats: synthesis.stats,
        recommendation: synthesis.recommendation,
      },
    };

    await redis.set(`review:result:${reviewId}`, JSON.stringify(result));
    await updateStatus(reviewId, "complete", 100, findings);

    await publish(`review:events:${reviewId}`, {
      type: "REVIEW_COMPLETE",
      summary: {
        totalFindings: summary.totalFindings,
        filesAnalyzed: summary.filesAnalyzed,
        durationMs: summary.durationMs,
        costUsd: summary.costUsd,
      },
    });

    log.info(
      { reviewId, durationMs, totalFindings: findings.length, commentsPosted: commentsPosted.length, costUsd: totalCostUsd },
      "Review completed successfully",
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ reviewId, error: errorMessage }, "Review failed");

    // Preserve findings and progress accumulated before failure
    let existingFindings: Finding[] = [];
    let existingPercentage = 0;
    try {
      const existingRaw = await redis.get(`review:${reviewId}`);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw) as Record<string, unknown>;
        if (Array.isArray(existing.findings)) existingFindings = existing.findings as Finding[];
        if (typeof existing.percentage === "number") existingPercentage = existing.percentage;
      }
    } catch { /* ignore parse error */ }

    await updateStatus(reviewId, "failed", existingPercentage, existingFindings, errorMessage);

    throw error;
  } finally {
    if (repoPath) {
      try {
        fs.rmSync(repoPath, { recursive: true, force: true });
      } catch {
        log.warn({ reviewId, repoPath }, "Failed to clean up clone directory");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary-only context helpers
// ---------------------------------------------------------------------------

const SUMMARY_DIFF_MAX_LINES = 200;

function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  const truncated = lines.slice(0, maxLines).join("\n");
  return `${truncated}\n... (diff truncated, ${lines.length - maxLines} more lines)`;
}

function buildSummaryContext(diffFile: DiffFile): ContextPackage {
  return {
    file: diffFile.path,
    diff: truncateDiff(diffFile.diff, SUMMARY_DIFF_MAX_LINES),
    fullFunctions: [],
    callers: [],
    callees: [],
    similarCode: [],
    usages: [],
  };
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

interface DegradationMode {
  noGraph: boolean;
  noVectors: boolean;
  slowLlm: boolean;
  noEmbeddings: boolean;
  noBitbucket: boolean;
}

interface AgentResult {
  findings: Finding[];
  traces: AgentTrace[];
}

/**
 * Run all specialist agents in parallel and collect their findings.
 * Respects degradation modes: skips agents that depend on unavailable services.
 */
async function runAgents(
  reviewId: string,
  contextPackages: ContextPackage[],
  degradation: DegradationMode,
  job: ReviewJob,
  repoContext: { repoId: string; repoPath: string },
  cancelKey: string,
): Promise<AgentResult> {
  await assertNotCancelled(cancelKey, "Review cancelled");
  const options = job.options || {};
  const contextText = contextPackages.map((ctx) =>
    `## File: ${ctx.file}\n\n### Diff\n\`\`\`\n${ctx.diff}\n\`\`\`\n\n` +
    (ctx.fullFunctions.length > 0 ? `### Full Functions\n\`\`\`\n${ctx.fullFunctions.join("\n\n")}\n\`\`\`\n\n` : "") +
    (ctx.callers.length > 0 ? `### Callers\n${ctx.callers.map((c) => `- ${c.function} (${c.file}:${c.line})`).join("\n")}\n\n` : "") +
    (ctx.callees.length > 0 ? `### Callees\n${ctx.callees.map((c) => `- ${c.function} (${c.file}:${c.line})`).join("\n")}\n\n` : "") +
    (ctx.similarCode.length > 0 ? `### Similar Code\n${ctx.similarCode.map((s) => `- ${s.function} (${s.file}, ${Math.round(s.similarity * 100)}% similar)`).join("\n")}\n\n` : "") +
    (ctx.usages.length > 0 ? `### Usages\n${ctx.usages.map((u) => `- ${u.file}:${u.line} ${u.content}`).join("\n")}\n\n` : "")
  ).join("\n---\n\n");

  const prompt = `Review the following code changes and provide your findings:\n\n${contextText}`;

  type AgentTask = { name: string; promise: Promise<{ findings: Finding[]; trace: AgentTrace }> };
  const agentTasks: AgentTask[] = [];
  const traces: AgentTrace[] = [];
  const runningAgents: string[] = [];

  // Security agent - always runs unless LLM is completely down or skipped
  if (!degradation.slowLlm && !options.skipSecurity) {
    await assertNotCancelled(cancelKey, "Review cancelled");
    agentTasks.push({ name: "security", promise: runSingleAgentWithTrace("security", reviewId, prompt, repoContext) });
    runningAgents.push("security");
  } else {
    traces.push(buildSkippedTrace("security"));
  }

  // Logic agent - always runs unless LLM is completely down
  if (!degradation.slowLlm) {
    await assertNotCancelled(cancelKey, "Review cancelled");
    agentTasks.push({ name: "logic", promise: runSingleAgentWithTrace("logic", reviewId, prompt, repoContext) });
    runningAgents.push("logic");
  } else {
    traces.push(buildSkippedTrace("logic"));
  }

  // Duplication agent - needs vectors
  if (!degradation.noVectors && !degradation.noEmbeddings && !options.skipDuplication) {
    await assertNotCancelled(cancelKey, "Review cancelled");
    agentTasks.push({ name: "duplication", promise: runSingleAgentWithTrace("duplication", reviewId, prompt, repoContext) });
    runningAgents.push("duplication");
  } else {
    if (options.skipDuplication) {
      log.info({ reviewId }, "Skipping duplication agent (disabled by user)");
    } else {
      log.info({ reviewId }, "Skipping duplication agent (vectors unavailable)");
    }
    traces.push(buildSkippedTrace("duplication"));
  }

  // API change agent - benefits from graph but can work without
  if (!degradation.slowLlm && !degradation.noGraph) {
    await assertNotCancelled(cancelKey, "Review cancelled");
    agentTasks.push({ name: "api-change", promise: runSingleAgentWithTrace("api-change", reviewId, prompt, repoContext) });
    runningAgents.push("api-change");
  } else {
    if (degradation.noGraph) {
      log.info({ reviewId }, "Skipping api-change agent (graph unavailable)");
    }
    traces.push(buildSkippedTrace("api-change"));
  }

  // Refactor agent - always runs
  if (!degradation.slowLlm) {
    await assertNotCancelled(cancelKey, "Review cancelled");
    agentTasks.push({ name: "refactor", promise: runSingleAgentWithTrace("refactor", reviewId, prompt, repoContext) });
    runningAgents.push("refactor");
  } else {
    traces.push(buildSkippedTrace("refactor"));
  }

  if (runningAgents.length > 0) {
    await updateStatus(reviewId, "running-agents", 45, [], undefined, undefined, [...runningAgents]);
  }

  const results = await Promise.allSettled(agentTasks.map((t) => t.promise));
  await assertNotCancelled(cancelKey, "Review cancelled");
  const allFindings: Finding[] = [];

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
      traces.push(result.value.trace);

      // Publish per-agent completion event
      await publish(`review:events:${reviewId}`, {
        type: "AGENT_COMPLETE",
        agent: taskName,
        findingsCount: result.value.findings.length,
        durationMs: result.value.trace.durationMs,
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
      traces.push({
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

  return { findings: allFindings, traces };
}

function buildSkippedTrace(agent: string): AgentTrace {
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

/**
 * Run a single agent with timing and token usage capture.
 */
async function runSingleAgentWithTrace(
  agentName: string,
  reviewId: string,
  prompt: string,
  repoContext: { repoId: string; repoPath: string },
): Promise<{ findings: Finding[]; trace: AgentTrace }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agents: Record<string, { generate: (prompt: string) => Promise<any> }> = {
    "security": securityAgent,
    "logic": logicAgent,
    "duplication": duplicationAgent,
    "api-change": apiChangeAgent,
    "refactor": refactorAgent,
  };

  const modelMap: Record<string, string> = {
    "security": MODELS.security,
    "logic": MODELS.logic,
    "duplication": MODELS.duplication,
    "api-change": MODELS.apiChange,
    "refactor": MODELS.refactor,
  };

  const agent = agents[agentName];
  if (!agent) {
    return { findings: [], trace: buildSkippedTrace(agentName) };
  }

  const startedAt = new Date();
  log.debug({ reviewId, agent: agentName }, "Running agent");

  try {
    const result = await openRouterBreaker.execute(async () => {
      return runWithRepoContext(repoContext, () => agent.generate(prompt));
    });

    const completedAt = new Date();
    const text = typeof result.text === "string" ? result.text : "";
    const findings = parseFindingsFromResponse(text, agentName);

    const inputTokens = (result as Record<string, unknown>).usage
      ? ((result as Record<string, unknown>).usage as Record<string, number>).promptTokens ?? 0
      : 0;
    const outputTokens = (result as Record<string, unknown>).usage
      ? ((result as Record<string, unknown>).usage as Record<string, number>).completionTokens ?? 0
      : 0;
    const model = modelMap[agentName] ?? "";
    const costUsd = calculateCost(model, inputTokens, outputTokens);

    return {
      findings,
      trace: {
        agent: agentName,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        inputTokens,
        outputTokens,
        costUsd,
        findingsCount: findings.length,
        status: "success",
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

/**
 * Parse a JSON findings array from an agent's text response.
 */
function parseFindingsFromResponse(text: string, agentName: string): Finding[] {
  try {
    const json = extractJsonObject(text);
    if (!json) return [];
    const parsed = JSON.parse(json) as { findings?: unknown[] };
    if (!Array.isArray(parsed.findings)) return [];

    return parsed.findings.map((item: unknown) => {
      const f = item as Record<string, unknown>;
      const related = f.relatedCode as Record<string, unknown> | undefined;
      const affected = Array.isArray(f.affectedFiles) ? f.affectedFiles as Record<string, unknown>[] : [];
      return {
        file: String(f.file ?? ""),
        line: Number(f.line ?? 0),
        severity: (f.severity as Severity) ?? "info",
        category: (f.category as Category) ?? (agentName === "security" ? "security" : "bug"),
        title: String(f.title ?? ""),
        description: String(f.description ?? ""),
        suggestion: f.suggestion ? String(f.suggestion) : undefined,
        confidence: Number(f.confidence ?? 0.5),
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
  } catch (error) {
    log.warn({ agent: agentName, error }, "Failed to parse agent findings");
    return [];
  }
}

function extractJsonObject(text: string): string | null {
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

/**
 * Use the synthesis agent to deduplicate, rank, and filter findings.
 */
type SynthesisOutput = {
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
};

async function synthesizeFindings(
  reviewId: string,
  findings: Finding[],
  degradation: DegradationMode,
): Promise<SynthesisOutput> {
  if (findings.length === 0) return { findings: [] };

  // If LLM is degraded, skip synthesis and return raw findings
  if (degradation.slowLlm) {
    log.info({ reviewId }, "Skipping synthesis (LLM degraded), returning raw findings");
    return { findings };
  }

  try {
    const prompt = `Synthesize and deduplicate the following findings:\n\n${JSON.stringify(findings, null, 2)}`;

    const result = await openRouterBreaker.execute(async () => {
      const response = await synthesisAgent.generate(prompt);
      return response;
    });

    const text = typeof result.text === "string" ? result.text : "";
    const synthesized = parseSynthesisOutput(text);
    if (synthesized && synthesized.findings.length > 0) return synthesized;
    return { findings };
  } catch (error) {
    log.warn({ reviewId, error }, "Synthesis failed, returning raw findings");
    return { findings };
  }
}

function parseSynthesisOutput(text: string): SynthesisOutput | null {
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

    return { findings, inlineComments, summaryComment, stats, recommendation };
  } catch (error) {
    log.warn({ error }, "Failed to parse synthesis output");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  findings: Finding[],
  filesAnalyzed: number,
  durationMs: number,
  costUsd: number,
): ReviewResult["summary"] {
  const bySeverity: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  const byCategory: Record<Category, number> = {
    security: 0, bug: 0, duplication: 0, "api-change": 0, refactor: 0,
  };

  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byCategory[finding.category]++;
  }

  return {
    totalFindings: findings.length,
    bySeverity,
    byCategory,
    filesAnalyzed,
    durationMs,
    costUsd,
  };
}

// ---------------------------------------------------------------------------
// Comment posting
// ---------------------------------------------------------------------------

async function postFindings(
  workspace: string,
  repoSlug: string,
  prNumber: number,
  token: string,
  findings: Finding[],
  summary: ReviewResult["summary"],
  synthesis?: SynthesisOutput,
  repoPath?: string,
  diffFiles?: DiffFile[],
  cancelKey?: string,
): Promise<ReviewResult["commentsPosted"]> {
  const posted: ReviewResult["commentsPosted"] = [];
  const diffMap = new Map<string, DiffFile>();
  if (diffFiles) {
    for (const file of diffFiles) diffMap.set(file.path, file);
  }
  const lineCountCache = new Map<string, number>();

  if (synthesis?.inlineComments && synthesis.inlineComments.length > 0) {
    for (const comment of synthesis.inlineComments) {
      try {
        if (cancelKey) {
          await assertNotCancelled(cancelKey, "Review cancelled");
        }
        const resolvedLine = resolveCommentLine(
          comment.file,
          comment.line,
          repoPath,
          diffMap,
          lineCountCache,
        );
        if (!resolvedLine) continue;
        const result = await bitbucketBreaker.execute(() =>
          bitbucketClient.postInlineComment(
            workspace, repoSlug, prNumber, token,
            comment.file, resolvedLine, comment.content,
          ),
        );
        posted.push({ commentId: result.id, file: comment.file, line: resolvedLine });
      } catch (error) {
        log.warn(
          { file: comment.file, line: comment.line, error: error instanceof Error ? error.message : String(error) },
          "Failed to post synthesized inline comment, skipping",
        );
      }
    }
  } else {
    for (const finding of findings) {
      try {
        if (cancelKey) {
          await assertNotCancelled(cancelKey, "Review cancelled");
        }
        const resolvedLine = resolveCommentLine(
          finding.file,
          finding.line,
          repoPath,
          diffMap,
          lineCountCache,
        );
        if (!resolvedLine) continue;
        const commentBody = formatFindingComment(finding);
        const result = await bitbucketBreaker.execute(() =>
          bitbucketClient.postInlineComment(
            workspace, repoSlug, prNumber, token,
            finding.file, resolvedLine, commentBody,
          ),
        );

        posted.push({ commentId: result.id, file: finding.file, line: resolvedLine });
      } catch (error) {
        log.warn(
          { file: finding.file, line: finding.line, error: error instanceof Error ? error.message : String(error) },
          "Failed to post inline comment, skipping",
        );
      }
    }
  }

  try {
    if (cancelKey) {
      await assertNotCancelled(cancelKey, "Review cancelled");
    }
    const summaryBody = synthesis?.summaryComment ?? formatSummaryComment(summary, findings.length);
    await bitbucketBreaker.execute(() =>
      bitbucketClient.postSummaryComment(workspace, repoSlug, prNumber, token, summaryBody),
    );
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to post summary comment",
    );
  }

  return posted;
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function resolveCommentLine(
  filePath: string,
  line: number,
  repoPath: string | undefined,
  diffMap: Map<string, DiffFile>,
  lineCountCache: Map<string, number>,
): number | null {
  const diffFile = diffMap.get(filePath);
  if (diffFile?.status === "deleted") return null;

  const lineCount = getFileLineCount(filePath, repoPath, lineCountCache);
  if (lineCount !== null && line >= 1 && line <= lineCount) {
    return line;
  }

  if (diffFile) {
    const mapped = mapDiffLineToFileLine(diffFile, line);
    if (mapped && (lineCount === null || mapped <= lineCount)) {
      return mapped;
    }
    const fallback = firstAddedLine(diffFile);
    if (fallback) return fallback;
  }

  return null;
}

function getFileLineCount(
  filePath: string,
  repoPath: string | undefined,
  cache: Map<string, number>,
): number | null {
  if (!repoPath) return null;
  if (cache.has(filePath)) return cache.get(filePath)!;
  try {
    const content = fs.readFileSync(path.join(repoPath, filePath), "utf-8");
    const count = content.split("\n").length;
    cache.set(filePath, count);
    return count;
  } catch {
    return null;
  }
}

function firstAddedLine(diffFile: DiffFile): number | null {
  const lines = diffFile.diff.split("\n");
  let currentNewLine: number | null = null;
  const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

  for (const rawLine of lines) {
    const hunkMatch = rawLine.match(hunkRegex);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1]!, 10);
      continue;
    }
    if (currentNewLine === null) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      return currentNewLine;
    }
    if (rawLine.startsWith("-")) {
      // deleted line
    } else {
      currentNewLine++;
    }
  }

  return null;
}

function formatFindingComment(finding: Finding): string {
  const severityEmoji: Record<Severity, string> = {
    critical: "\u{1F534}", high: "\u{1F7E0}", medium: "\u{1F7E1}", low: "\u{1F535}", info: "\u26AA",
  };

  const lines = [
    `${severityEmoji[finding.severity]} **${finding.severity.toUpperCase()}** | ${finding.category}`,
    "",
    `**${finding.title}**`,
    "",
    finding.description,
  ];

  if (finding.suggestion) {
    lines.push("", "**Suggestion:**", finding.suggestion);
  }
  if (finding.cwe) {
    lines.push("", `_CWE: ${finding.cwe}_`);
  }
  if (finding.confidence < 0.8) {
    lines.push("", `_Confidence: ${Math.round(finding.confidence * 100)}%_`);
  }

  return lines.join("\n");
}

function formatSummaryComment(
  summary: ReviewResult["summary"],
  totalFindings: number,
): string {
  const lines = [
    "## PR Review Summary",
    "",
    `**Files analyzed:** ${summary.filesAnalyzed}`,
    `**Total findings:** ${totalFindings}`,
    `**Duration:** ${(summary.durationMs / 1000).toFixed(1)}s`,
    `**Cost:** $${summary.costUsd.toFixed(4)}`,
    "",
    "### Findings by Severity",
    "",
    `| Severity | Count |`,
    `|----------|-------|`,
    `| Critical | ${summary.bySeverity.critical} |`,
    `| High | ${summary.bySeverity.high} |`,
    `| Medium | ${summary.bySeverity.medium} |`,
    `| Low | ${summary.bySeverity.low} |`,
    `| Info | ${summary.bySeverity.info} |`,
    "",
    "### Findings by Category",
    "",
    `| Category | Count |`,
    `|----------|-------|`,
    `| Security | ${summary.byCategory.security} |`,
    `| Bug | ${summary.byCategory.bug} |`,
    `| Duplication | ${summary.byCategory.duplication} |`,
    `| API Change | ${summary.byCategory["api-change"]} |`,
    `| Refactor | ${summary.byCategory.refactor} |`,
  ];

  if (totalFindings === 0) {
    lines.push("", "No issues found. Looks good! :tada:");
  }

  lines.push("", "---", "_Automated review by SupplyHouse Reviewer_");

  return lines.join("\n");
}
