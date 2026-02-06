/**
 * Review workflow orchestrator.
 *
 * This is the main entry point for executing a code review. It coordinates
 * all phases: fetching PR data, building context, running agents, verifying
 * findings, synthesizing results, and posting comments.
 *
 * Each phase is implemented in its own module:
 *   - response-parsers.ts   — JSON extraction from agent text
 *   - comment-formatting.ts — Bitbucket comment text builders
 *   - status-helpers.ts     — Redis status broadcasting
 *   - agent-runner.ts       — Specialist agent execution
 *   - planner-phase.ts      — Planner agent + PR facts formatting
 *   - verification-phase.ts — False positive verification
 *   - synthesis-phase.ts    — Finding deduplication and ranking
 *   - comment-poster.ts     — Bitbucket comment posting
 *   - review-helpers.ts     — Clone, indexing, cost, summary
 */

import type { ReviewJob } from "../types/review.ts";
import type { Finding, ReviewResult, AgentTrace } from "../types/findings.ts";
import type { ContextPackage } from "./context-builder.ts";
import type { DiffFile, PRDetails } from "../types/bitbucket.ts";
import type { Logger } from "pino";
import * as fs from "fs";
import { bitbucketClient } from "../bitbucket/client.ts";
import { parseDiff } from "../bitbucket/diff-parser.ts";
import { buildContext } from "./context-builder.ts";
import { prioritizeFiles } from "./large-pr.ts";
import { redis, publish } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { env } from "../config/env.ts";
import { bitbucketBreaker } from "../services/breakers.ts";
import { getDegradationMode } from "../services/degradation.ts";
import { checkEmbeddingAvailability } from "../utils/embedding-availability.ts";
import { runSyntaxValidation, filterSyntaxFindingsToChangedLines } from "./syntax-validators.ts";
import { repoIdFromSlug } from "../utils/repo-identity.ts";
import { getIndexingStrategyId } from "../indexing/strategies/index.ts";
import { fetchToken } from "../utils/token-store.ts";
import { assertNotCancelled, isCancelled, reviewCancelKey } from "../utils/cancellation.ts";
import {
  buildRepoStrategyProfile,
  getRepoStrategyProfile,
  setRepoMeta,
  setRepoStrategyProfile,
} from "../utils/repo-meta.ts";
import {
  consolidateSimilarFindings,
  filterFindingsByContent,
  filterFindingsForInline,
  filterFindingsForQuality,
} from "./comment-filters.ts";
import {
  applyLineResolution,
  buildDiffIndex,
  suppressMoveFalsePositives,
} from "./diff-indexer.ts";
import { buildDomainFactsIndex } from "./domain-facts.ts";
import { applyEvidenceGates } from "./evidence-gates.ts";
import type { PlannerOutput } from "./response-parsers.ts";
import { buildRepoDocsContext } from "./repo-docs-context.ts";

// Extracted modules
import { emitActivity, updateStatus, estimateReviewDuration } from "./status-helpers.ts";
import { formatStartedComment, formatCompletedComment, formatFailedComment } from "./comment-formatting.ts";
import { runAgents } from "./agent-runner.ts";
import { buildSummaryContext, formatPrFacts, formatPrDomainFacts, formatPlannerNotes, runPlannerAgent } from "./planner-phase.ts";
import { runVerificationPhase } from "./verification-phase.ts";
import { synthesizeFindings } from "./synthesis-phase.ts";
import { postFindings } from "./comment-poster.ts";
import { cloneRepoForReview, indexRepoIfNeeded, verifyCostsInBackground, buildSummary } from "./review-helpers.ts";

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
      const plannerResult = await runPlannerAgent(reviewId, diffFiles, diffIndex, prDomainFactsText);
      plannerOutput = plannerResult.output;
    }
    const plannerNotes = formatPlannerNotes(plannerOutput);
    const combinedPlannerNotes = [
      plannerNotes,
      prDomainFactsText ? `PR Domain Facts:\n${prDomainFactsText}` : "",
    ].filter(Boolean).join("\n");

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
    // Step 3.7: Build repo docs context
    // ------------------------------------------------------------------
    let repoDocsContext: string | null = null;
    try {
      repoDocsContext = await buildRepoDocsContext({
        repoId, diffFiles, prDetails,
      });
      if (repoDocsContext) {
        await emitActivity(reviewId, "Loaded repo docs context for agents");
      }
    } catch (error) {
      log.warn({ reviewId, error: error instanceof Error ? error.message : String(error) }, "Failed to build repo docs context");
    }

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
      { repoId, repoPath },
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

    // Fire-and-forget: re-fetch OpenRouter costs after a short delay
    void verifyCostsInBackground(reviewId, traces);

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

