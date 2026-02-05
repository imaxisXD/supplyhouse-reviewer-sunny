import { Elysia } from "elysia";
import { redis } from "../db/redis.ts";
import { getBreakerStates } from "../services/breakers.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("api:reviews-list");

export const reviewsListRoutes = new Elysia({ prefix: "/api" })
  .get("/reviews", async ({ query }) => {
    const limit = Math.min(parseInt((query as Record<string, string>).limit ?? "50", 10), 200);

    // UUID pattern to filter only review:<uuid> keys (not review:result:*, review:cancel:*, etc.)
    const UUID_RE = /^review:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

    try {
      // Scan for review status keys (review:<uuid>)
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "review:*", "COUNT", 100);
        cursor = nextCursor;
        for (const key of batch) {
          if (UUID_RE.test(key)) keys.push(key);
        }
      } while (cursor !== "0" && keys.length < limit * 3);

      const reviews = [];
      for (const key of keys.slice(0, limit * 2)) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const status = JSON.parse(raw);
          const reviewId = key.replace("review:", "");

          let totalFindings = status.findingsCount ?? (Array.isArray(status.findings) ? status.findings.length : 0);
          let durationMs = 0;
          let costUsd = 0;
          let filesAnalyzed = 0;

          // Enrich completed reviews with result data
          if (status.phase === "complete") {
            try {
              const resultRaw = await redis.get(`review:result:${reviewId}`);
              if (resultRaw) {
                const result = JSON.parse(resultRaw);
                totalFindings = result.summary?.totalFindings ?? totalFindings;
                durationMs = result.summary?.durationMs ?? 0;
                costUsd = result.summary?.costUsd ?? 0;
                filesAnalyzed = result.summary?.filesAnalyzed ?? 0;
              }
            } catch { /* skip */ }
          }

          reviews.push({
            id: reviewId,
            phase: status.phase ?? "queued",
            totalFindings,
            durationMs,
            costUsd,
            filesAnalyzed,
            startedAt: status.startedAt,
            completedAt: status.completedAt,
            error: status.phase === "failed" ? status.error : undefined,
            prUrl: status.prUrl,
          });
        } catch {
          // Skip unparseable entries
        }
      }

      // Sort by most recent first
      reviews.sort((a, b) => {
        const dateA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const dateB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return dateB - dateA;
      });

      return { reviews: reviews.slice(0, limit), total: reviews.length };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to list reviews");
      return { reviews: [], total: 0 };
    }
  })
  .get("/metrics", async () => {
    const MAX_METRICS_KEYS = 1000;
    try {
      // Scan review results (capped to avoid unbounded scans)
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "review:result:*", "COUNT", 100);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== "0" && keys.length < MAX_METRICS_KEYS);

      let totalReviews = keys.length;
      let totalFindings = 0;
      let totalDurationMs = 0;
      let totalCostUsd = 0;
      const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const result = JSON.parse(raw);
          const summary = result.summary;
          if (summary) {
            totalFindings += summary.totalFindings ?? 0;
            totalDurationMs += summary.durationMs ?? 0;
            totalCostUsd += summary.costUsd ?? 0;
            if (summary.bySeverity) {
              severityCounts.critical += summary.bySeverity.critical ?? 0;
              severityCounts.high += summary.bySeverity.high ?? 0;
              severityCounts.medium += summary.bySeverity.medium ?? 0;
              severityCounts.low += summary.bySeverity.low ?? 0;
              severityCounts.info += summary.bySeverity.info ?? 0;
            }
          }
        } catch {
          // Skip
        }
      }

      const circuitBreakers = getBreakerStates();

      return {
        totalReviews,
        totalFindings,
        avgDurationMs: totalReviews > 0 ? Math.round(totalDurationMs / totalReviews) : 0,
        totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
        severityCounts,
        circuitBreakers,
      };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to compute metrics");
      return {
        totalReviews: 0,
        totalFindings: 0,
        avgDurationMs: 0,
        totalCostUsd: 0,
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        circuitBreakers: {},
      };
    }
  });
