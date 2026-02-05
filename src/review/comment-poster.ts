/**
 * Bitbucket comment posting — handles posting inline findings and
 * summary comments to a pull request.
 */

import type { Finding, AgentTrace, ReviewResult } from "../types/findings.ts";
import type { DiffFile } from "../types/bitbucket.ts";
import type { SynthesisOutput } from "./response-parsers.ts";
import { bitbucketClient } from "../bitbucket/client.ts";
import { bitbucketBreaker } from "../services/breakers.ts";
import { redis } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { assertNotCancelled } from "../utils/cancellation.ts";
import { resolveCommentLine } from "./comment-filters.ts";
import { formatFindingComment, formatSummaryComment } from "./comment-formatting.ts";
import { isCancellationError } from "./status-helpers.ts";

const log = createLogger("comment-poster");

export async function postFindings(
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
