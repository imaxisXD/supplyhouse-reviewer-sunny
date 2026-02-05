import type { ReviewJob, ReviewStatus, ReviewPhase } from "../types/review.ts";
import type { Finding, ReviewResult, Severity, Category, AgentTrace } from "../types/findings.ts";
import type { ContextPackage } from "./context-builder.ts";
import type { DiffFile, PRDetails } from "../types/bitbucket.ts";
import type { Logger } from "pino";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { bitbucketClient } from "../bitbucket/client.ts";
import { parseDiff } from "../bitbucket/diff-parser.ts";
import { buildContext } from "./context-builder.ts";
import { prioritizeFiles } from "./large-pr.ts";
import { redis, publish } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { env } from "../config/env.ts";
import { bitbucketBreaker, openRouterBreaker } from "../services/breakers.ts";
import { getDegradationMode, type DegradationMode } from "../services/degradation.ts";
import { fetchOpenRouterCostUsd } from "../services/openrouter-cost.ts";
import {
  securityAgent,
  logicAgent,
  duplicationAgent,
  apiChangeAgent,
  refactorAgent,
  plannerAgent,
  synthesisAgent,
  completenessAgent,
  verificationAgent,
} from "../mastra/index.ts";
import { duplicationGrepAgent } from "../agents/duplication-grep.ts";
import { checkEmbeddingAvailability } from "../utils/embedding-availability.ts";
import { runSyntaxValidation, filterSyntaxFindingsToChangedLines } from "./syntax-validators.ts";
import { runWithRepoContext as dataFlowContext } from "../tools/repo-context.ts";
import { runWithRepoContext } from "../tools/repo-context.ts";
import { repoIdFromSlug } from "../utils/repo-identity.ts";
import type { ParsedFile } from "../indexing/parsers/base.ts";
import { collectionName, generateAndStoreEmbeddings, invalidateCollectionCache } from "../indexing/embedding-generator.ts";
import { detectFrameworks } from "../indexing/framework-detector.ts";
import { buildGraph } from "../indexing/graph-builder.ts";
import { collectSourceFiles, extractSnippets, getParserForFile } from "../indexing/source-collector.ts";
import { getIndexingStrategyId } from "../indexing/strategies/index.ts";
import { buildOfbizGraph, collectOfbizFiles, extractOfbizSnippets, parseOfbizFiles, tagJavaNodes } from "../indexing/strategies/ofbiz-supplyhouse.ts";
import { qdrantClient } from "../db/qdrant.ts";
import { runCypher } from "../db/memgraph.ts";
import { fetchToken } from "../utils/token-store.ts";
import { assertNotCancelled, isCancelled, reviewCancelKey } from "../utils/cancellation.ts";
import {
  buildRepoStrategyProfile,
  getRepoStrategyProfile,
  setRepoMeta,
  setRepoStrategyProfile,
} from "../utils/repo-meta.ts";
import { reviewQueue } from "../queue/queue-instance.ts";
import {
  consolidateSimilarFindings,
  filterFindingsByContent,
  filterFindingsForInline,
  filterFindingsForQuality,
  resolveCommentLine,
} from "./comment-filters.ts";
import {
  applyLineResolution,
  buildDiffIndex,
  buildSummaryDiff,
  isMetaDiffLine,
  suppressMoveFalsePositives,
} from "./diff-indexer.ts";
import { buildDomainFactsIndex, type FileDomainFacts, type PrDomainFacts } from "./domain-facts.ts";
import { applyEvidenceGates } from "./evidence-gates.ts";
import { buildRepoDocsContext } from "./repo-docs-context.ts";

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
    if (token.includes(":")) {
      // App Password format — email:app_password or username:app_password
      // Git clone requires the real Bitbucket username, not the email.
      // Resolve it via the API so callers can always pass email:password.
      const pass = token.split(":").slice(1).join(":");
      let gitUser = token.split(":")[0]!;
      try {
        const profile = await bitbucketClient.getAuthenticatedUser(token);
        if (profile.username) gitUser = profile.username;
      } catch (err) {
        log.warn({ workspace, repoSlug, error: err instanceof Error ? err.message : String(err) },
          "Could not resolve Bitbucket username for git clone; using provided user");
      }
      url.username = encodeURIComponent(gitUser);
      url.password = encodeURIComponent(pass);
    } else {
      // OAuth / Bearer token
      url.username = "x-token-auth";
      url.password = token;
    }
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
    // Sanitize both auth formats from error output
    const sanitized = stderr
      .replace(/x-token-auth:[^@]+@/g, "x-token-auth:***@")
      .replace(/:\/\/[^:]+:[^@]+@/g, "://***:***@");
    throw new Error(`git clone failed (exit ${exitCode}): ${sanitized}`);
  }

  return cloneDir;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

async function emitActivity(reviewId: string, message: string): Promise<void> {
  await publish(`review:events:${reviewId}`, {
    type: "ACTIVITY_LOG",
    message,
    timestamp: new Date().toISOString(),
  });
}

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
      if (typeof existing.prUrl === "string") {
        status.prUrl = existing.prUrl;
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
  if (existingPhase === "cancelling" && phase !== "failed" && phase !== "complete") {
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
// Review time estimation
// ---------------------------------------------------------------------------

async function estimateReviewDuration(): Promise<{ estimateMinutes: number; queueDepth: number }> {
  let queueDepth = 0;
  try {
    queueDepth = await reviewQueue.getWaitingCount();
  } catch {
    // If queue introspection fails, default to 0
  }

  const SAMPLE_SIZE = 20;
  let totalDurationMs = 0;
  let count = 0;

  try {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "review:result:*", "COUNT", "50");
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0" && keys.length < SAMPLE_SIZE);

    for (const key of keys.slice(0, SAMPLE_SIZE)) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;
        const result = JSON.parse(raw) as { summary?: { durationMs?: number } };
        if (result.summary?.durationMs) {
          totalDurationMs += result.summary.durationMs;
          count++;
        }
      } catch { /* skip */ }
    }
  } catch { /* If Redis scan fails, use default */ }

  const avgDurationMs = count > 0 ? totalDurationMs / count : 120_000;
  const totalEstimateMs = avgDurationMs + queueDepth * avgDurationMs;
  const estimateMinutes = Math.max(1, Math.round(totalEstimateMs / 60_000));

  return { estimateMinutes, queueDepth };
}

// ---------------------------------------------------------------------------
// Status comment formatting
// ---------------------------------------------------------------------------

function formatStartedComment(estimateMinutes: number, queueDepth: number): string {
  const lines = [
    "\uD83D\uDC41\uFE0F **Review in progress**",
    "",
    "The SupplyHouse Reviewer bot is analyzing this pull request.",
  ];

  if (queueDepth > 0) {
    lines.push(`There ${queueDepth === 1 ? "is 1 review" : `are ${queueDepth} reviews`} ahead in the queue.`);
  }

  lines.push(`Estimated time: ~${estimateMinutes} minute${estimateMinutes !== 1 ? "s" : ""}.`);
  lines.push("", "---", "_Automated review by SupplyHouse Reviewer_");

  return lines.join("\n");
}

function formatCompletedComment(summary: ReviewResult["summary"], totalFindings: number): string {
  const lines = [
    "\uD83D\uDC4D **Review complete**",
    "",
    `Analyzed **${summary.filesAnalyzed}** files and found **${totalFindings}** issue${totalFindings !== 1 ? "s" : ""}.`,
    `Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
    "",
    "See inline comments for details and the summary comment below.",
    "",
    "---",
    "_Automated review by SupplyHouse Reviewer_",
  ];

  return lines.join("\n");
}

function formatFailedComment(errorMessage: string): string {
  const lines = [
    "\u274C **Review failed**",
    "",
    `Error: ${errorMessage}`,
    "",
    "---",
    "_Automated review by SupplyHouse Reviewer_",
  ];

  return lines.join("\n");
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes("cancelled") || lower.includes("canceled");
}

// ---------------------------------------------------------------------------
// Auto-index before review
// ---------------------------------------------------------------------------

async function indexRepoIfNeeded(
  repoId: string,
  repoPath: string,
  reviewId: string,
  cancelKey: string,
  changedFiles: string[],
  useEmbeddings: boolean,
): Promise<boolean> {
  const strategyId = getIndexingStrategyId(repoId);
  const isOfbiz = strategyId === "ofbiz-supplyhouse";

  const collection = collectionName(repoId);
  let alreadyIndexed = false;
  try {
    const info = await qdrantClient.getCollection(collection);
    if (info.points_count && info.points_count > 0) {
      alreadyIndexed = true;
    }
  } catch {
    alreadyIndexed = false;
  }

  if (alreadyIndexed && (!isOfbiz || changedFiles.length === 0)) {
    log.info({ repoId, collection }, "Repo already indexed, skipping");
    await emitActivity(reviewId, "Repository already indexed, skipping indexing");
    return false;
  }

  const modeLabel = alreadyIndexed ? "incremental" : "full";
  log.info({ repoId, reviewId, mode: modeLabel, strategyId }, "Auto-indexing repo before review");
  await updateStatus(reviewId, "indexing", 16);
  await emitActivity(reviewId, `Starting ${modeLabel} repository indexing...`);
  await assertNotCancelled(cancelKey, "Review cancelled");

  const detections = await detectFrameworks(repoPath);
  const excludePatterns = new Set<string>([
    ...detections.flatMap((d) => d.excludePatterns),
  ]);
  const frameworkNames = detections.map((d) => d.framework);
  await emitActivity(reviewId, frameworkNames.length > 0
    ? `Frameworks detected: ${frameworkNames.join(", ")}`
    : "No specific frameworks detected");
  await updateStatus(reviewId, "indexing", 17);

  if (alreadyIndexed && isOfbiz && changedFiles.length > 0) {
    try {
      await runCypher(
        `MATCH (f:File) WHERE f.repoId = $repoId AND f.path IN $paths DETACH DELETE f`,
        { repoId, paths: changedFiles },
      );
      await runCypher(
        `MATCH (fn:Function) WHERE fn.repoId = $repoId AND fn.file IN $paths DETACH DELETE fn`,
        { repoId, paths: changedFiles },
      );
      await runCypher(
        `MATCH (c:Class) WHERE c.repoId = $repoId AND c.file IN $paths DETACH DELETE c`,
        { repoId, paths: changedFiles },
      );
      const extraLabels = [
        "Component",
        "Webapp",
        "Controller",
        "RequestMap",
        "ViewMap",
        "Screen",
        "Form",
        "Service",
        "Entity",
        "TemplateFTL",
        "BshScript",
        "JSFile",
      ];
      for (const label of extraLabels) {
        await runCypher(
          `MATCH (n:${label}) WHERE n.repoId = $repoId AND n.file IN $paths DETACH DELETE n`,
          { repoId, paths: changedFiles },
        );
      }
    } catch (error) {
      log.warn({ repoId, error: error instanceof Error ? error.message : String(error) }, "Failed to delete old graph data");
    }

    try {
      await qdrantClient.delete(collection, {
        filter: {
          must: [
            { key: "repoId", match: { value: repoId } },
            { key: "file", match: { any: changedFiles } },
          ],
        },
      });
      invalidateCollectionCache(repoId);
    } catch (error) {
      log.warn({ repoId, error: error instanceof Error ? error.message : String(error) }, "Failed to delete old embeddings");
    }
  }

  let sourceFiles: string[] = [];
  let ofbizData = null as ReturnType<typeof parseOfbizFiles> | null;
  if (isOfbiz) {
    const ofbizFileSet = collectOfbizFiles(repoPath, excludePatterns, alreadyIndexed, changedFiles);
    sourceFiles = ofbizFileSet.codeFiles;
    ofbizData = parseOfbizFiles(repoPath, ofbizFileSet);
  } else {
    sourceFiles = collectSourceFiles(repoPath, excludePatterns);
  }

  const parsedFiles: ParsedFile[] = [];
  for (const filePath of sourceFiles) {
    const parser = getParserForFile(filePath);
    if (!parser) continue;
    try {
      const code = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(repoPath, filePath);
      parsedFiles.push(parser.parse(code, relativePath));
    } catch {
      // skip unparseable files
    }
  }
  await emitActivity(reviewId, `Collected and parsed ${parsedFiles.length} source files`);
  await updateStatus(reviewId, "indexing", 18);
  await assertNotCancelled(cancelKey, "Review cancelled");

  await buildGraph(repoId, parsedFiles);
  if (isOfbiz && ofbizData) {
    await tagJavaNodes(repoId, parsedFiles);
    await buildOfbizGraph(repoId, ofbizData);
  }
  await emitActivity(reviewId, "Knowledge graph built");
  await updateStatus(reviewId, "indexing", 19);
  await assertNotCancelled(cancelKey, "Review cancelled");

  // Only generate embeddings if useEmbeddings is enabled
  if (useEmbeddings) {
    let snippets = extractSnippets(parsedFiles);
    if (isOfbiz) {
      snippets = snippets.filter((s) => !s.file.toLowerCase().endsWith(".ftl"));
    }
    if (isOfbiz && ofbizData) {
      snippets.push(...extractOfbizSnippets(repoPath, ofbizData));
    }
    const stored = await generateAndStoreEmbeddings(repoId, snippets);
    invalidateCollectionCache(repoId);
    await emitActivity(reviewId, `Generated ${stored} embeddings`);
    log.info({ repoId, files: parsedFiles.length, embeddings: stored }, "Auto-indexing complete");
  } else {
    await emitActivity(reviewId, "Graph-only indexing complete (embeddings skipped)");
    log.info({ repoId, files: parsedFiles.length }, "Auto-indexing complete (graph only)");
  }
  await updateStatus(reviewId, "indexing", 20);
  return true;
}

// ---------------------------------------------------------------------------
// Review execution
// ---------------------------------------------------------------------------

export async function executeReview(job: ReviewJob, sessionLogger?: Logger): Promise<ReviewResult> {
  const { id: reviewId, workspace, repoSlug, prNumber } = job;

  // Use session logger if provided, otherwise fall back to module-level logger
  const log = sessionLogger ?? createLogger("review-workflow");

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
  let startedCommentId: string | null = null;
  let prDetails: PRDetails | undefined;

  // Check if embeddings are requested and available
  const useEmbeddings = job.options?.useEmbeddings ?? false;
  const repoId = repoIdFromSlug(workspace, repoSlug);
  let embeddingStatus = { available: false, pointsCount: 0, collectionExists: false };
  if (useEmbeddings && !degradation.noVectors && !degradation.noEmbeddings) {
    embeddingStatus = await checkEmbeddingAvailability(repoId);
  }
  // Note: hasEmbeddings may be recalculated after indexing if embeddings were generated
  let hasEmbeddings = useEmbeddings && embeddingStatus.available;

  log.info({ reviewId, workspace, repoSlug, prNumber, degradation, useEmbeddings, hasEmbeddings }, "Starting review");

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
    if (degradation.slowLlm) {
      throw new Error("LLM service is unavailable (circuit breaker open). Review cannot be performed.");
    }
    await assertNotCancelled(cancelKey, "Review cancelled");
    const tokenValue = token;
    // ------------------------------------------------------------------
    // Step 1: Fetch PR diff
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "fetching-pr", 5);
    await emitActivity(reviewId, "Fetching PR diff from Bitbucket...");
    await assertNotCancelled(cancelKey, "Review cancelled");

    const rawDiff = await bitbucketBreaker.execute(() =>
      bitbucketClient.getPRDiff(workspace, repoSlug, prNumber, tokenValue),
    );
    await emitActivity(reviewId, "PR diff fetched successfully");

    // Post "Review Started" comment on the PR
    if (!degradation.noBitbucket) {
      try {
        const { estimateMinutes, queueDepth } = await estimateReviewDuration();
        const startedBody = formatStartedComment(estimateMinutes, queueDepth);
        const startedResult = await bitbucketBreaker.execute(() =>
          bitbucketClient.postSummaryComment(workspace, repoSlug, prNumber, tokenValue, startedBody),
        );
        startedCommentId = startedResult.id;
        log.info({ reviewId, startedCommentId }, "Posted review-started comment");
      } catch (error) {
        log.warn(
          { reviewId, error: error instanceof Error ? error.message : String(error) },
          "Failed to post review-started comment, continuing",
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 2: Parse diff + prioritize files
    // ------------------------------------------------------------------
    const diffFiles = parseDiff(rawDiff);
    await emitActivity(reviewId, `Parsed diff: ${diffFiles.length} files changed`);
    const repoId = repoIdFromSlug(workspace, repoSlug);
    const diffIndex = buildDiffIndex(diffFiles);
    const prFacts = formatPrFacts(diffIndex, diffFiles);
    const prioritized = prioritizeFiles(diffFiles, job.options?.priorityFiles);
    const fullAnalysisFiles = prioritized.filter((f) => f.fullAnalysis).map((f) => f.file);
    const summaryOnlyFiles = prioritized.filter((f) => !f.fullAnalysis).map((f) => f.file);
    await emitActivity(reviewId, `${fullAnalysisFiles.length} files for full analysis, ${summaryOnlyFiles.length} summary-only`);
    const droppedFiles = diffFiles.length - prioritized.length;

    // Step 2.5: Resolve PR source branch + clone repository
    let branch = job.branch;
    let sourceWorkspace = job.sourceWorkspace;
    let sourceRepoSlug = job.sourceRepoSlug;

    // Always fetch PR details — we need title/description for synthesis
    // and branch/workspace for cloning
    try {
      prDetails = await bitbucketBreaker.execute(() =>
        bitbucketClient.getPRDetails(workspace, repoSlug, prNumber, tokenValue),
      );
      await emitActivity(reviewId, `PR details loaded: ${prDetails.sourceBranch} → ${prDetails.targetBranch}`);
      branch = branch || prDetails.sourceBranch || prDetails.targetBranch || "main";
      sourceWorkspace = sourceWorkspace || prDetails.sourceWorkspace;
      sourceRepoSlug = sourceRepoSlug || prDetails.sourceRepoSlug;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn({ reviewId, error: msg }, "Failed to fetch PR details; defaulting to main branch");
      branch = branch || "main";
    }
    const cloneWorkspace = sourceWorkspace || workspace;
    const cloneRepoSlug = sourceRepoSlug || repoSlug;
    repoPath = await cloneRepoForReview(cloneWorkspace, cloneRepoSlug, branch, tokenValue);
    await emitActivity(reviewId, "Repository cloned successfully");
    await updateStatus(reviewId, "fetching-pr", 15);
    await assertNotCancelled(cancelKey, "Review cancelled");

    const repoUrl = `https://bitbucket.org/${workspace}/${repoSlug}`;
    try {
      await setRepoMeta({ repoId, repoUrl, branch });
      log.info({ repoId, repoUrl, branch }, "Stored repo metadata from review");
    } catch (error) {
      log.warn({ repoId, error: error instanceof Error ? error.message : String(error) }, "Failed to store repo metadata from review");
    }

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
    // Step 2.7: Auto-index if needed
    // ------------------------------------------------------------------
    const changedFiles = diffFiles
      .filter((f) => f.status !== "deleted")
      .map((f) => f.path);
    const didIndex = await indexRepoIfNeeded(repoId, repoPath, reviewId, cancelKey, changedFiles, useEmbeddings);

    // Recalculate embedding availability if we just indexed with embeddings
    if (didIndex && useEmbeddings && !hasEmbeddings) {
      const updatedStatus = await checkEmbeddingAvailability(repoId);
      hasEmbeddings = updatedStatus.available;
      log.info({ reviewId, hasEmbeddings, pointsCount: updatedStatus.pointsCount }, "Rechecked embedding availability after indexing");
    }

    // ------------------------------------------------------------------
    // Step 2.8: Load repo strategy profile + domain facts
    // ------------------------------------------------------------------
    let strategyProfile = await getRepoStrategyProfile(repoId);
    if (!strategyProfile || didIndex) {
      const strategyId = getIndexingStrategyId(repoId);
      const lastIndexedAt = didIndex ? new Date().toISOString() : strategyProfile?.lastIndexedAt;
      strategyProfile = buildRepoStrategyProfile(repoId, strategyId, lastIndexedAt);
      try {
        await setRepoStrategyProfile(strategyProfile);
      } catch (error) {
        log.warn({ repoId, error: error instanceof Error ? error.message : String(error) }, "Failed to store repo strategy profile during review");
      }
    }

    const domainFactsIndex = await buildDomainFactsIndex(
      repoId,
      diffFiles,
      strategyProfile,
      { skipGraph: degradation.noGraph },
    );
    const prDomainFactsText = formatPrDomainFacts(domainFactsIndex.prFacts);
    log.info(
      {
        reviewId,
        repoId,
        domainFactsFiles: domainFactsIndex.byFile.size,
        prEntities: domainFactsIndex.prFacts.entities?.length ?? 0,
        prServices: domainFactsIndex.prFacts.services?.length ?? 0,
        prTemplates: domainFactsIndex.prFacts.templates?.length ?? 0,
        prScripts: domainFactsIndex.prFacts.scripts?.length ?? 0,
      },
      "Domain facts prepared for review",
    );

    let plannerOutput: PlannerOutput | null = null;
    if (!degradation.slowLlm) {
      plannerOutput = await runPlannerAgent(reviewId, diffFiles, diffIndex, prDomainFactsText);
    }
    const plannerNotes = formatPlannerNotes(plannerOutput);
    const combinedPlannerNotes = [
      plannerNotes,
      prDomainFactsText ? `PR Domain Facts:\n${prDomainFactsText}` : "",
    ].filter(Boolean).join("\n");

    let repoDocsContext: string | null = null;
    try {
      repoDocsContext = await buildRepoDocsContext({
        repoId,
        diffFiles,
        prDetails,
      });
      if (repoDocsContext) {
        log.info({ reviewId, repoId }, "Repo docs context prepared");
      }
    } catch (error) {
      log.warn(
        { reviewId, repoId, error: error instanceof Error ? error.message : String(error) },
        "Failed to build repo docs context",
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Build context
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "building-context", 20);
    await assertNotCancelled(cancelKey, "Review cancelled");

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
        skipVectors: !hasEmbeddings || degradation.noVectors || degradation.noEmbeddings,
        domainFactsByFile: domainFactsIndex.byFile,
        repoStrategyProfile: strategyProfile,
      },
    );
    const summaryContextPackages = summaryOnlyFiles.map((file) =>
      buildSummaryContext(file, domainFactsIndex.byFile.get(file.path)),
    );
    const fullByPath = new Map(fullContextPackages.map((pkg) => [pkg.file, pkg]));
    const summaryByPath = new Map(summaryContextPackages.map((pkg) => [pkg.file, pkg]));
    const contextPackages = prioritized
      .map((entry) => fullByPath.get(entry.file.path) ?? summaryByPath.get(entry.file.path))
      .filter((pkg): pkg is ContextPackage => Boolean(pkg));
    await updateStatus(reviewId, "building-context", 40);
    await assertNotCancelled(cancelKey, "Review cancelled");

    // ------------------------------------------------------------------
    // Step 3.5: Syntax Validation (pre-agent, no LLM needed)
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "validating-syntax", 42);
    await emitActivity(reviewId, "Running syntax validation...");

    const syntaxFindings = runSyntaxValidation(repoPath, diffFiles);
    const filteredSyntaxFindings = filterSyntaxFindingsToChangedLines(syntaxFindings, diffFiles);

    if (filteredSyntaxFindings.length > 0) {
      await emitActivity(reviewId, `Found ${filteredSyntaxFindings.length} syntax issue(s)`);
      log.info(
        { reviewId, syntaxFindings: filteredSyntaxFindings.length },
        "Syntax validation complete",
      );
    }
    await assertNotCancelled(cancelKey, "Review cancelled");

    // ------------------------------------------------------------------
    // Step 4: Run agents
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "running-agents", 45);
    await assertNotCancelled(cancelKey, "Review cancelled");
    log.info({ reviewId }, "Running analysis agents");

    const agentsStart = Date.now();
    const { findings: agentFindings, traces } = await runAgents(
      reviewId,
      contextPackages,
      degradation,
      job,
      { repoId, repoPath },
      cancelKey,
      hasEmbeddings,
      { prFacts, plannerNotes: combinedPlannerNotes, repoDocs: repoDocsContext ?? undefined },
    );
    const agentsDurationMs = Date.now() - agentsStart;
    log.info(
      { reviewId, durationMs: agentsDurationMs, findings: agentFindings.length, traces: traces.length },
      "Analysis agents completed",
    );
    // Combine syntax findings with agent findings
    const combinedFindings = [...filteredSyntaxFindings, ...agentFindings];
    const diffMap = new Map<string, DiffFile>();
    for (const diffFile of diffFiles) {
      diffMap.set(diffFile.path, diffFile);
    }
    const { findings: resolvedFindings, corrected, dropped: droppedForLine } = applyLineResolution(combinedFindings, diffIndex);
    const { findings: qualityFindings, dropped } = filterFindingsForQuality(resolvedFindings, diffMap);

    // Consolidate similar findings (e.g., multiple "null check" issues in same file)
    const { findings: consolidatedFindings, consolidatedCount } = consolidateSimilarFindings(qualityFindings);

    // Validate that findings point to relevant code (catches line number misalignment)
    const { findings: validatedFindings, droppedForContentMismatch } = filterFindingsByContent(consolidatedFindings, diffMap);
    const { findings: gatedFindings, stats: gateStats } = applyEvidenceGates(validatedFindings, {
      repoPath,
      diffFiles,
      domainFactsByFile: domainFactsIndex.byFile,
      strategyId: strategyProfile?.strategyId,
    });
    const { findings: moveVerifiedFindings, suppressed } = suppressMoveFalsePositives(gatedFindings, diffIndex);

    // ------------------------------------------------------------------
    // Step 4.5: Verification Phase - Disprove False Positives
    // ------------------------------------------------------------------
    let verifiedFindings = moveVerifiedFindings;
    let disprovenFindings: Finding[] = [];
    let disprovenCount = 0;

    // Only run verification if we have findings and LLM is available
    if (moveVerifiedFindings.length > 0 && !degradation.slowLlm) {
      await updateStatus(reviewId, "verifying-findings", 72, moveVerifiedFindings);
      await emitActivity(reviewId, `Verifying ${moveVerifiedFindings.length} finding(s)...`);
      await assertNotCancelled(cancelKey, "Review cancelled");

      try {
        const verificationStart = Date.now();
        log.info(
          { reviewId, original: moveVerifiedFindings.length },
          "Verification phase started",
        );
        const verificationResult = await runVerificationPhase(
          reviewId,
          moveVerifiedFindings,
          { repoId, repoPath },
          cancelKey,
        );

        verifiedFindings = verificationResult.verifiedFindings;
        disprovenFindings = verificationResult.disprovenFindings;
        disprovenCount = verificationResult.disprovenCount;
        const verificationDurationMs = Date.now() - verificationStart;
        log.info(
          {
            reviewId,
            durationMs: verificationDurationMs,
            original: moveVerifiedFindings.length,
            verified: verifiedFindings.length,
            disproven: disprovenCount,
          },
          "Verification phase finished",
        );

        if (disprovenCount > 0) {
          await emitActivity(reviewId, `Verification complete: ${disprovenCount} false positive(s) removed`);
          log.info(
            { reviewId, original: moveVerifiedFindings.length, verified: verifiedFindings.length, disproven: disprovenCount },
            "Verification phase complete",
          );
        }
      } catch (error) {
        // Verification is optional - if it fails, continue with unverified findings
        log.warn(
          { reviewId, error: error instanceof Error ? error.message : String(error) },
          "Verification phase failed, continuing with unverified findings",
        );
        verifiedFindings = moveVerifiedFindings;
      }
    }

    const inlineFindings = filterFindingsForInline(verifiedFindings);
    const inlineSuppressed = Math.max(verifiedFindings.length - inlineFindings.length, 0);
    log.debug(
      {
        reviewId,
        totalFindings: combinedFindings.length,
        lineCorrected: corrected,
        lineDropped: droppedForLine,
        afterQualityFilter: qualityFindings.length,
        afterConsolidation: consolidatedFindings.length,
        consolidatedCount,
        afterContentValidation: validatedFindings.length,
        droppedForContentMismatch,
        evidenceGateDropped: gateStats.dropped,
        evidenceGateDowngraded: gateStats.downgraded,
        evidenceGateEntityDrops: gateStats.droppedEntityFields,
        evidenceGateSecurityDowngrades: gateStats.downgradedSecurity,
        evidenceGateLegacyTargets: gateStats.legacyTargetsDetected,
        evidenceGateLegacyDrops: gateStats.droppedLegacyBrowser,
        suppressedMoves: suppressed,
        inlineFindings: inlineFindings.length,
        inlineSuppressed,
        dropped,
        apiChangeEvidenceFiles: dropped.apiChangeEvidenceFiles,
      },
      "Filtered, consolidated, and validated findings",
    );
    await updateStatus(reviewId, "running-agents", 70, verifiedFindings);

    // ------------------------------------------------------------------
    // Step 5: Synthesize results
    // ------------------------------------------------------------------
    await updateStatus(reviewId, "synthesizing", 75, verifiedFindings);
    await assertNotCancelled(cancelKey, "Review cancelled");
    const diffFilesMeta = diffFiles.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
    const synthesisStart = Date.now();
    log.info({ reviewId, findings: verifiedFindings.length }, "Synthesis started");
    const synthesis = await synthesizeFindings(
      reviewId, verifiedFindings, degradation,
      prDetails?.title, prDetails?.description, diffFilesMeta,
    );
    const synthesisDurationMs = Date.now() - synthesisStart;
    log.info(
      {
        reviewId,
        durationMs: synthesisDurationMs,
        findings: synthesis.findings.length,
        inlineComments: synthesis.inlineComments?.length ?? 0,
      },
      "Synthesis finished",
    );
    await assertNotCancelled(cancelKey, "Review cancelled");
    const findings = synthesis.findings.length > 0 ? synthesis.findings : verifiedFindings;

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
      const postStart = Date.now();
      log.info({ reviewId, findings: findings.length }, "Posting comments started");
      await updateStatus(reviewId, "posting-comments", 90, findings);
      commentsPosted = await postFindings(
        workspace, repoSlug, prNumber, tokenValue, findings, summary,
        synthesis, repoPath, diffFiles, cancelKey, traces, reviewId, inlineFindings,
      );
      const postDurationMs = Date.now() - postStart;
      log.info(
        { reviewId, durationMs: postDurationMs, commentsPosted: commentsPosted.length },
        "Posting comments finished",
      );
    }
    await assertNotCancelled(cancelKey, "Review cancelled");

    // Update the "Review Started" comment to show completion
    if (startedCommentId && !degradation.noBitbucket) {
      try {
        const completedBody = formatCompletedComment(summary, findings.length);
        await bitbucketBreaker.execute(() =>
          bitbucketClient.updateComment(
            workspace, repoSlug, prNumber, tokenValue, startedCommentId!, completedBody,
          ),
        );
        log.info({ reviewId, startedCommentId }, "Updated review-started comment to complete");
      } catch (error) {
        log.warn(
          { reviewId, startedCommentId, error: error instanceof Error ? error.message : String(error) },
          "Failed to update review-started comment, continuing",
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 7: Store result and mark complete
    // ------------------------------------------------------------------
    const result: ReviewResult = {
      findings,
      disprovenFindings: disprovenFindings.length > 0 ? disprovenFindings : undefined,
      summary: {
        ...summary,
        disprovenCount: disprovenCount > 0 ? disprovenCount : undefined,
      },
      commentsPosted,
      traces,
      prUrl: job.prUrl,
      options: job.options,
      synthesis: {
        inlineComments: synthesis.inlineComments,
        summaryComment: synthesis.summaryComment,
        stats: synthesis.stats,
        recommendation: synthesis.recommendation,
        confidenceScore: synthesis.confidenceScore,
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

    // Best-effort: update the started comment to show failure
    if (startedCommentId && token) {
      try {
        const failedBody = formatFailedComment(errorMessage);
        await bitbucketClient.updateComment(
          workspace, repoSlug, prNumber, token, startedCommentId, failedBody,
        );
      } catch { /* best-effort, ignore failures */ }
    }

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
const SUMMARY_CONTEXT_LINES = 3;

function buildSummaryContext(diffFile: DiffFile, domainFacts?: FileDomainFacts): ContextPackage {
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
// Planner agent helpers
// ---------------------------------------------------------------------------

interface PlannerOutput {
  summary: string;
  focusFiles: string[];
  moveNotes: string[];
  riskNotes: string[];
  agentHints: string[];
}

function formatPrFacts(diffIndex: ReturnType<typeof buildDiffIndex>, diffFiles: DiffFile[]): string {
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

function formatPrDomainFacts(facts: PrDomainFacts): string {
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

function formatPlannerNotes(planner: PlannerOutput | null): string {
  if (!planner) return "";
  const lines: string[] = [];
  if (planner.summary) lines.push(`Summary: ${planner.summary}`);
  if (planner.focusFiles?.length) lines.push(`Focus files: ${planner.focusFiles.join(", ")}`);
  if (planner.moveNotes?.length) lines.push(`Move notes: ${planner.moveNotes.join("; ")}`);
  if (planner.riskNotes?.length) lines.push(`Risk notes: ${planner.riskNotes.join("; ")}`);
  if (planner.agentHints?.length) lines.push(`Agent hints: ${planner.agentHints.join("; ")}`);
  return lines.join("\n");
}

function parsePlannerOutput(text: string): PlannerOutput | null {
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

async function runPlannerAgent(
  reviewId: string,
  diffFiles: DiffFile[],
  diffIndex: ReturnType<typeof buildDiffIndex>,
  prDomainFactsText?: string,
): Promise<PlannerOutput | null> {
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
    const result = await openRouterBreaker.execute(async () => plannerAgent.generate(prompt));
    const text = typeof result.text === "string" ? result.text : "";
    return parsePlannerOutput(text);
  } catch (error) {
    log.warn(
      { reviewId, error: error instanceof Error ? error.message : String(error) },
      "Planner agent failed; continuing without planner notes",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

interface AgentResult {
  findings: Finding[];
  traces: AgentTrace[];
}

/**
 * Rough token estimate: ~4 chars per token for code.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_TOKENS_PER_BATCH = 80_000;

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
function annotateDiffWithLineNumbers(diff: string): string {
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

function formatDomainFacts(facts?: FileDomainFacts): string {
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
function formatContextText(
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

/**
 * Split context packages into batches that fit within the token budget.
 */
function batchContextPackages(
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

/**
 * Run all specialist agents in parallel and collect their findings.
 * Respects degradation modes: skips agents that depend on unavailable services.
 * For large PRs, files are batched and agents are run per batch to stay within token limits.
 */
async function runAgents(
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
  promptContext?: { hasRepoDocsContext: boolean; hasRepoDocsExcerpts: boolean },
): Promise<{ findings: Finding[]; trace: AgentTrace }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agents: Record<string, { generate: (prompt: string) => Promise<any> }> = {
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
      return runWithRepoContext(repoContext, () => agent.generate(prompt));
    });

    const completedAt = new Date();
    const text = typeof result.text === "string" ? result.text : "";
    const findings = parseFindingsFromResponse(text, agentName);

    // Extract usage data from response
    const usage = (result as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.promptTokens === "number" ? usage.promptTokens : 0;
    const outputTokens = typeof usage?.completionTokens === "number" ? usage.completionTokens : 0;

    // Try to get cost directly from usage object (OpenRouter includes this in responses)
    // Fall back to generation endpoint if not available
    const directCost = typeof usage?.cost === "number" ? usage.cost : null;
    const generationId = result.response?.id;
    const costUsd = directCost ?? (generationId ? (await fetchOpenRouterCostUsd(generationId)) ?? 0 : 0);

    // Debug log to verify cost retrieval method
    log.debug(
      { reviewId, agent: agentName, directCost, generationId, costUsd },
      "Agent cost tracking",
    );

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

const VALID_SEVERITIES: Set<Severity> = new Set(["critical", "high", "medium", "low", "info"]);
const VALID_CATEGORIES: Set<Category> = new Set(["security", "bug", "duplication", "api-change", "refactor"]);
const AGENT_DEFAULT_CATEGORY: Record<string, Category> = {
  security: "security",
  logic: "bug",
  duplication: "duplication",
  "api-change": "api-change",
  refactor: "refactor",
  completeness: "security", // Missing controls are security-related
};

function parseFindingsFromResponse(text: string, agentName: string): Finding[] {
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
      });
    }

    return findings;
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

// ---------------------------------------------------------------------------
// Verification Phase
// ---------------------------------------------------------------------------

interface VerificationResult {
  verifiedFindings: Finding[];
  disprovenFindings: Finding[];
  disprovenCount: number;
}

/**
 * Run the verification phase to disprove false positives.
 * Uses the verification agent to semantically analyze findings and determine
 * if they're actually exploitable.
 */
async function runVerificationPhase(
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
  let disprovenCount = 0;

  for (const batch of batches) {
    await assertNotCancelled(cancelKey, "Review cancelled");

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
        return runWithRepoContext(repoContext, () => verificationAgent.generate(prompt));
      });

      const text = typeof result.text === "string" ? result.text : "";
      const parsed = parseVerificationResponse(text, batch);

      verifiedFindings.push(...parsed.verified);
      disprovenFindings.push(...parsed.disproven);
      disprovenCount += parsed.disprovenCount;
    } catch (error) {
      log.warn(
        { reviewId, error: error instanceof Error ? error.message : String(error) },
        "Verification batch failed, keeping original findings",
      );
      // If verification fails, keep original findings
      verifiedFindings.push(...batch);
    }
  }

  return { verifiedFindings, disprovenFindings, disprovenCount };
}

/**
 * Parse verification response from the agent
 */
function parseVerificationResponse(
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
  confidenceScore?: number;
};

async function synthesizeFindings(
  reviewId: string,
  findings: Finding[],
  degradation: DegradationMode,
  prTitle?: string,
  prDescription?: string,
  diffFilesMeta?: { path: string; status: string; additions: number; deletions: number }[],
): Promise<SynthesisOutput> {
  if (findings.length === 0) return { findings: [], confidenceScore: 5 };

  // If LLM is degraded, skip synthesis and return raw findings
  if (degradation.slowLlm) {
    log.info({ reviewId }, "Skipping synthesis (LLM degraded), returning raw findings");
    return { findings };
  }

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
  traces?: AgentTrace[],
  reviewId?: string,
  inlineFindings: Finding[] = [],
): Promise<ReviewResult["commentsPosted"]> {
  const posted: ReviewResult["commentsPosted"] = [];
  const diffMap = new Map<string, DiffFile>();
  if (diffFiles) {
    for (const file of diffFiles) diffMap.set(file.path, file);
  }
  const inlineAllowlist = new Set<string>(
    inlineFindings.map((finding) => `${finding.file}:${finding.line}`),
  );

  // Load previously posted comments to prevent duplicates on BullMQ retries
  const postedSetKey = reviewId ? `review:posted-comments:${reviewId}` : null;
  const alreadyPosted = new Set<string>();
  if (postedSetKey) {
    try {
      const raw = await redis.get(postedSetKey);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        for (const k of arr) alreadyPosted.add(k);
      }
    } catch {
      // Ignore parse errors
    }
  }

  async function tryPostInlineComment(file: string, line: number, content: string): Promise<void> {
    const commentKey = `${file}:${line}`;
    if (alreadyPosted.has(commentKey)) {
      log.debug({ file, line }, "Comment already posted (retry dedup), skipping");
      return;
    }
    const resolvedLine = resolveCommentLine(file, line, diffMap);
    if (!resolvedLine) {
      log.debug({ reviewId, file, line, hasDiffFile: diffMap.has(file) }, "Comment skipped: line not in diff");
      return;
    }
    log.debug({ reviewId, file, line: resolvedLine }, "Posting inline comment to Bitbucket");
    const result = await bitbucketBreaker.execute(() =>
      bitbucketClient.postInlineComment(workspace, repoSlug, prNumber, token, file, resolvedLine, content),
    );
    log.info({ reviewId, file, line: resolvedLine, commentId: result.id }, "Inline comment posted successfully");
    posted.push({ commentId: result.id, file, line: resolvedLine });
    alreadyPosted.add(commentKey);
  }

  log.info(
    {
      reviewId,
      inlineFindingsCount: inlineFindings.length,
      synthesisCommentsCount: synthesis?.inlineComments?.length ?? 0,
      allowlistSize: inlineAllowlist.size,
      diffFilesCount: diffMap.size,
    },
    "Starting inline comment posting",
  );

  if (synthesis?.inlineComments && synthesis.inlineComments.length > 0) {
    log.debug({ reviewId }, "Using synthesis inline comments");
    let skippedNotInAllowlist = 0;
    for (const comment of synthesis.inlineComments) {
      const allowKey = `${comment.file}:${comment.line}`;
      if (!inlineAllowlist.has(allowKey)) {
        skippedNotInAllowlist++;
        log.debug({ reviewId, file: comment.file, line: comment.line }, "Synthesis comment skipped: not in allowlist");
        continue;
      }
      try {
        if (cancelKey) await assertNotCancelled(cancelKey, "Review cancelled");
        await tryPostInlineComment(comment.file, comment.line, comment.content);
      } catch (error) {
        if (isCancellationError(error)) throw error;
        log.warn(
          { file: comment.file, line: comment.line, error: error instanceof Error ? error.message : String(error) },
          "Failed to post synthesized inline comment, skipping",
        );
      }
    }
    if (skippedNotInAllowlist > 0) {
      log.info({ reviewId, skippedNotInAllowlist }, "Some synthesis comments skipped (not in allowlist)");
    }
  } else {
    log.debug({ reviewId, inlineFindingsCount: inlineFindings.length }, "Using raw findings for inline comments");
    for (const finding of inlineFindings) {
      try {
        if (cancelKey) await assertNotCancelled(cancelKey, "Review cancelled");
        const commentBody = formatFindingComment(finding);
        await tryPostInlineComment(finding.file, finding.line, commentBody);
      } catch (error) {
        if (isCancellationError(error)) throw error;
        log.warn(
          { file: finding.file, line: finding.line, error: error instanceof Error ? error.message : String(error) },
          "Failed to post inline comment, skipping",
        );
      }
    }
  }

  // Persist posted comments set so retries can skip already-posted
  if (postedSetKey && alreadyPosted.size > 0) {
    try {
      await redis.set(postedSetKey, JSON.stringify([...alreadyPosted]), "EX", 86400);
    } catch {
      // Non-critical, best-effort dedup
    }
  }

  try {
    if (cancelKey) {
      await assertNotCancelled(cancelKey, "Review cancelled");
    }
    log.debug({ reviewId }, "Posting summary comment to Bitbucket");
    const summaryBody = synthesis?.summaryComment ?? formatSummaryComment(summary, findings.length, traces, findings, synthesis?.recommendation);
    await bitbucketBreaker.execute(() =>
      bitbucketClient.postSummaryComment(workspace, repoSlug, prNumber, token, summaryBody),
    );
    log.info({ reviewId }, "Summary comment posted successfully");
  } catch (error) {
    if (isCancellationError(error)) throw error;
    log.warn(
      { reviewId, error: error instanceof Error ? error.message : String(error) },
      "Failed to post summary comment",
    );
  }

  log.info({ reviewId, postedCount: posted.length }, "Finished posting comments to Bitbucket");
  return posted;
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function formatFindingComment(finding: Finding): string {
  const severityEmoji: Record<Severity, string> = {
    critical: "\u{1F534}", high: "\u{1F7E0}", medium: "\u{1F7E1}", low: "\u{1F535}", info: "\u26AA",
  };

  const categoryEmoji: Record<Category, string> = {
    security: "\u{1F512}",    // 🔒
    bug: "\u{1F41B}",         // 🐛
    duplication: "\u{1F4CB}", // 📋
    "api-change": "\u{26A0}\u{FE0F}",  // ⚠️
    refactor: "\u{1F9F9}",    // 🧹
  };

  const catEmoji = categoryEmoji[finding.category] ?? "";

  const lines = [
    `${severityEmoji[finding.severity]} **${finding.severity.toUpperCase()}** | ${catEmoji} ${finding.category}`,
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

const AGENT_TO_CATEGORY: Record<string, Category> = {
  security: "security",
  logic: "bug",
  duplication: "duplication",
  "api-change": "api-change",
  refactor: "refactor",
};

function computeCodeQualityScore(findings: Finding[]): number {
  if (findings.length === 0) return 5;
  const sev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.severity in sev) sev[f.severity as keyof typeof sev]++;
  }
  if (sev.critical > 0 || sev.high >= 3) return 1;
  if (sev.high > 0) return 2;
  if (sev.medium > 0) return 3;
  if (sev.low > 0) return 4;
  return 5;
}

function formatSummaryComment(
  summary: ReviewResult["summary"],
  totalFindings: number,
  _traces?: AgentTrace[],
  findings?: Finding[],
  recommendation?: string,
): string {
  const lines = [
    "## \uD83D\uDD0D Review Summary",
    "",
    `\uD83D\uDCCA Analyzed **${summary.filesAnalyzed}** files \u00B7 Found **${totalFindings}** issue${totalFindings !== 1 ? "s" : ""} \u00B7 \u23F1 ${(summary.durationMs / 1000).toFixed(1)}s`,
    "",
  ];

  if (totalFindings === 0) {
    lines.push("\u2705 No issues found. Code looks clean.", "");
  } else {
    // Severity overview line
    const parts: string[] = [];
    if (summary.bySeverity.critical > 0) parts.push(`\uD83D\uDD34 **${summary.bySeverity.critical} Critical**`);
    if (summary.bySeverity.high > 0) parts.push(`\uD83D\uDFE0 **${summary.bySeverity.high} High**`);
    if (summary.bySeverity.medium > 0) parts.push(`\uD83D\uDFE1 **${summary.bySeverity.medium} Medium**`);
    if (summary.bySeverity.low > 0) parts.push(`\uD83D\uDD35 **${summary.bySeverity.low} Low**`);
    if (summary.bySeverity.info > 0) parts.push(`\u26AA **${summary.bySeverity.info} Info**`);
    lines.push(parts.join(" \u00B7 "), "");

    if (findings && findings.length > 0) {
      const bySev: Record<string, Finding[]> = { critical: [], high: [], medium: [], low: [], info: [] };
      for (const f of findings) {
        if (f.severity in bySev) bySev[f.severity]!.push(f);
      }

      // Critical
      if (bySev.critical!.length > 0) {
        lines.push("### \uD83D\uDD34 Critical");
        for (const f of bySev.critical!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // High
      if (bySev.high!.length > 0) {
        lines.push("### \uD83D\uDFE0 High Priority");
        for (const f of bySev.high!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // Medium — show all with file:line
      if (bySev.medium!.length > 0) {
        lines.push("### \uD83D\uDFE1 Medium");
        for (const f of bySev.medium!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // Low — show all with file:line (so users can find them)
      if (bySev.low!.length > 0) {
        lines.push("### \uD83D\uDD35 Low");
        for (const f of bySev.low!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // Info — show all with file:line
      if (bySev.info!.length > 0) {
        lines.push("### \u26AA Info");
        for (const f of bySev.info!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }
    }
  }

  // Code Quality Score + Recommendation
  const score = findings ? computeCodeQualityScore(findings) : 5;
  let rec = recommendation;
  if (!rec) {
    if (totalFindings === 0) rec = "Safe to merge";
    else if (summary.bySeverity.critical > 0) rec = "Request changes \u2014 critical issues need attention";
    else if (summary.bySeverity.high >= 2) rec = "Request changes \u2014 multiple high-severity issues found";
    else if (summary.bySeverity.high === 1) rec = "Review suggested \u2014 one high-severity issue needs attention";
    else rec = "Safe to merge after fixing the issues above";
  }
  lines.push(`**Code Quality: ${score}/5** \u00B7 ${rec}`, "");

  lines.push("---", "_Automated review by SupplyHouse Reviewer_");

  return lines.join("\n");
}
