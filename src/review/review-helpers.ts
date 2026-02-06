/**
 * Miscellaneous review helpers — repo cloning, auto-indexing,
 * cost verification, and summary building.
 */

import type { Finding, Severity, Category, AgentTrace, ReviewResult } from "../types/findings.ts";
import type { ParsedFile } from "../indexing/parsers/base.ts";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { bitbucketClient } from "../bitbucket/client.ts";
import { redis } from "../db/redis.ts";
import { qdrantClient } from "../db/qdrant.ts";
import { runCypher } from "../db/memgraph.ts";
import { createLogger } from "../config/logger.ts";
import { fetchOpenRouterCostUsd } from "../services/openrouter-cost.ts";
import { collectionName, generateAndStoreEmbeddings, invalidateCollectionCache } from "../indexing/embedding-generator.ts";
import { detectFrameworks } from "../indexing/framework-detector.ts";
import { buildGraph } from "../indexing/graph-builder.ts";
import { collectSourceFiles, extractSnippets, getParserForFile } from "../indexing/source-collector.ts";
import { getIndexingStrategyId } from "../indexing/strategies/index.ts";
import { buildOfbizGraph, collectOfbizFiles, extractOfbizSnippets, parseOfbizFiles, tagJavaNodes } from "../indexing/strategies/ofbiz-supplyhouse.ts";
import { assertNotCancelled } from "../utils/cancellation.ts";
import { emitActivity, updateStatus } from "./status-helpers.ts";

const log = createLogger("review-helpers");
const CLONE_BASE_DIR = process.env.CLONE_DIR || "/tmp/supplyhouse-repos";

// ---------------------------------------------------------------------------
// Clone helper
// ---------------------------------------------------------------------------

export async function cloneRepoForReview(
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
// Auto-index before review
// ---------------------------------------------------------------------------

export async function indexRepoIfNeeded(
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
// Background cost verification
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: re-fetches costs from OpenRouter for all traces with a
 * generationId and updates the stored review result in Redis if any cost changed.
 */
export async function verifyCostsInBackground(reviewId: string, traces: AgentTrace[]): Promise<void> {
  try {
    // Wait for OpenRouter to index generation stats
    await Bun.sleep(3000);

    const tracesWithGenId = traces.filter((t) => t.generationId);
    if (tracesWithGenId.length === 0) return;

    let anyChanged = false;
    for (const trace of tracesWithGenId) {
      const freshCost = await fetchOpenRouterCostUsd(trace.generationId!);
      if (freshCost !== null && freshCost !== trace.costUsd) {
        log.info(
          { reviewId, agent: trace.agent, oldCost: trace.costUsd, newCost: freshCost },
          "Cost updated from OpenRouter verification",
        );
        trace.costUsd = freshCost;
        anyChanged = true;
      }
    }

    if (!anyChanged) return;

    // Re-read stored result, apply updated trace costs, and re-save
    const raw = await redis.get(`review:result:${reviewId}`);
    if (!raw) return;
    const result = JSON.parse(raw) as ReviewResult;

    for (const updatedTrace of tracesWithGenId) {
      const stored = result.traces?.find(
        (t) => t.agent === updatedTrace.agent && t.generationId === updatedTrace.generationId,
      );
      if (stored) stored.costUsd = updatedTrace.costUsd;
    }

    const newTotalCost = (result.traces ?? []).reduce((sum, t) => sum + t.costUsd, 0);
    result.summary.costUsd = newTotalCost;

    await redis.set(`review:result:${reviewId}`, JSON.stringify(result));
    log.info({ reviewId, newTotalCost }, "Review cost verified and updated from OpenRouter");
  } catch (error) {
    log.warn(
      { reviewId, error: error instanceof Error ? error.message : String(error) },
      "Background cost verification failed (non-fatal)",
    );
  }
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

export function buildSummary(
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
