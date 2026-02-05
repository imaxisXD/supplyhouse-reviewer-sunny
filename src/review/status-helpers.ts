/**
 * Review status broadcasting and estimation helpers.
 *
 * Handles publishing status updates to Redis/WebSocket and estimating
 * review duration from historical data.
 */

import type { ReviewStatus, ReviewPhase } from "../types/review.ts";
import type { Finding } from "../types/findings.ts";
import { redis, publish } from "../db/redis.ts";
import { reviewQueue } from "../queue/queue-instance.ts";

// ---------------------------------------------------------------------------
// Activity broadcasting
// ---------------------------------------------------------------------------

export async function emitActivity(reviewId: string, message: string): Promise<void> {
  await publish(`review:events:${reviewId}`, {
    type: "ACTIVITY_LOG",
    message,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

export async function updateStatus(
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

export async function estimateReviewDuration(): Promise<{ estimateMinutes: number; queueDepth: number }> {
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
// Error classification
// ---------------------------------------------------------------------------

export function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes("cancelled") || lower.includes("canceled");
}
