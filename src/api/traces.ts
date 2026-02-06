import { Elysia } from "elysia";
import { mastra } from "../mastra/index.ts";
import { redis } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("api:traces");

/** Helper — returns the observability store or null. */
async function getObservabilityStore() {
  const storage = mastra.getStorage();
  if (!storage) return null;
  return storage.getStore("observability");
}

/** Collect all root spans by paginating (perPage capped at 100 by Mastra). */
async function collectAllRootSpans(
  observability: NonNullable<Awaited<ReturnType<typeof getObservabilityStore>>>,
  filters?: Record<string, unknown>,
) {
  const allSpans: Record<string, unknown>[] = [];
  let page = 0;
  let hasMore = true;
  while (hasMore && page < 10) {
    const result = await observability.listTraces({
      pagination: { page, perPage: 100 },
      orderBy: { field: "startedAt", direction: "DESC" },
      ...(filters ? { filters } : {}),
    });
    const batch = result.spans ?? [];
    allSpans.push(...(batch as Record<string, unknown>[]));
    hasMore = result.pagination?.hasMore ?? false;
    page++;
  }
  return allSpans;
}

/**
 * Normalise a Mastra span record into the shape expected by the dashboard.
 * Mastra stores `startedAt`/`endedAt` as Date objects and uses `spanId`;
 * the frontend expects `startTime`/`endTime` as ISO strings and `id`.
 */
function normaliseSpan(span: Record<string, unknown>) {
  const startedAt = span.startedAt;
  const endedAt = span.endedAt;
  return {
    id: span.spanId ?? span.id,
    traceId: span.traceId,
    parentSpanId: span.parentSpanId ?? null,
    name: span.name ?? "",
    scope: span.scope ?? null,
    startTime:
      startedAt instanceof Date
        ? startedAt.toISOString()
        : typeof startedAt === "string"
          ? startedAt
          : null,
    endTime:
      endedAt instanceof Date
        ? endedAt.toISOString()
        : typeof endedAt === "string"
          ? endedAt
          : null,
    input: span.input ?? null,
    output: span.output ?? null,
    attributes: span.attributes ?? null,
    status: span.error
      ? { code: 2, message: String(span.error) }
      : endedAt
        ? { code: 0 }
        : { code: 1 },
  };
}

function toISOString(val: unknown): string | null {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val;
  return null;
}

/**
 * API routes for Mastra observability traces.
 * Exposes trace data from the LibSQL storage for the dashboard UI.
 */
export const traceRoutes = new Elysia({ prefix: "/api/traces" })
  /**
   * GET /api/traces/stats
   * Note: static routes must be defined before /:traceId
   */
  .get("/stats", async () => {
    try {
      const observability = await getObservabilityStore();
      if (!observability) return { totalTraces: 0, totalSpans: 0, avgDurationMs: 0, spanTypeCount: {} };

      const allSpans = await collectAllRootSpans(observability);

      let totalDurationMs = 0;
      const spanTypeCount: Record<string, number> = {};

      for (const span of allSpans) {
        const name = span.name as string || "unknown";
        spanTypeCount[name] = (spanTypeCount[name] || 0) + 1;

        const startedAt = span.startedAt;
        const endedAt = span.endedAt;
        if (startedAt && endedAt) {
          const start = startedAt instanceof Date ? startedAt.getTime() : new Date(String(startedAt)).getTime();
          const end = endedAt instanceof Date ? endedAt.getTime() : new Date(String(endedAt)).getTime();
          totalDurationMs += end - start;
        }
      }

      return {
        totalTraces: allSpans.length,
        totalSpans: allSpans.length,
        avgDurationMs: allSpans.length > 0 ? Math.round(totalDurationMs / allSpans.length) : 0,
        spanTypeCount,
      };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to get trace stats");
      return { totalTraces: 0, totalSpans: 0, avgDurationMs: 0, spanTypeCount: {} };
    }
  })

  /**
   * GET /api/traces/by-review
   * Groups root spans by reviewId (stored in metadata.reviewId via tracingOptions).
   * For legacy spans without metadata.reviewId, correlates them to reviews
   * stored in Redis by matching agent start times (±5 s window).
   */
  .get("/by-review", async () => {
    try {
      const observability = await getObservabilityStore();
      if (!observability) return { reviews: [] };

      const allSpans = await collectAllRootSpans(observability);

      // ------------------------------------------------------------------
      // 1. Build review index from Redis review results for time-matching
      // ------------------------------------------------------------------
      interface ReviewMeta {
        reviewId: string;
        prUrl?: string;
        agentWindows: { agent: string; startMs: number; endMs: number }[];
        overallStart: number;
        overallEnd: number;
      }
      const reviewIndex: ReviewMeta[] = [];
      {
        const resultKeys: string[] = [];
        let cursor = "0";
        do {
          const [next, batch] = await redis.scan(cursor, "MATCH", "review:result:*", "COUNT", 100);
          cursor = next as string;
          resultKeys.push(...(batch as string[]));
        } while (cursor !== "0");

        for (const key of resultKeys) {
          try {
            const raw = await redis.get(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw as string) as Record<string, unknown>;
            const traces = parsed.traces as { agent: string; startedAt?: string; completedAt?: string }[] | undefined;
            if (!traces || traces.length === 0) continue;

            const reviewId = key.replace("review:result:", "");
            let overallStart = Infinity;
            let overallEnd = 0;
            const agentWindows = traces.map((t) => {
              const s = t.startedAt ? new Date(t.startedAt).getTime() : 0;
              const e = t.completedAt ? new Date(t.completedAt).getTime() : 0;
              if (s < overallStart) overallStart = s;
              if (e > overallEnd) overallEnd = e;
              return { agent: t.agent, startMs: s, endMs: e };
            });

            // Also check review status key for prUrl
            let prUrl = parsed.prUrl as string | undefined;
            if (!prUrl) {
              try {
                const statusRaw = await redis.get(`review:${reviewId}`);
                if (statusRaw) {
                  const statusParsed = JSON.parse(statusRaw as string) as Record<string, unknown>;
                  prUrl = statusParsed.prUrl as string | undefined;
                }
              } catch { /* ignore */ }
            }

            reviewIndex.push({ reviewId, prUrl, agentWindows, overallStart, overallEnd });
          } catch { /* skip malformed entries */ }
        }
      }

      // ------------------------------------------------------------------
      // 2. Assign each span to a review: first by metadata, then by time
      // ------------------------------------------------------------------
      const MATCH_TOLERANCE_MS = 5_000; // 5 s window for agent start time matching
      const WINDOW_BEFORE_MS = 5 * 60_000; // 5 min before first agent (planner runs first)
      const WINDOW_AFTER_MS = 5 * 60_000; // 5 min after last agent (synthesis/verification run last)
      const groups = new Map<string, Record<string, unknown>[]>();
      const prUrlMap = new Map<string, string | undefined>();

      for (const review of reviewIndex) {
        prUrlMap.set(review.reviewId, review.prUrl);
      }

      for (const span of allSpans) {
        const meta = span.metadata as Record<string, unknown> | null | undefined;
        let assignedReviewId = (meta?.reviewId as string) || "";

        // Time-based correlation for unlinked spans
        if (!assignedReviewId) {
          const spanName = ((span.name as string) || "").toLowerCase();
          const spanStartStr = toISOString(span.startedAt);
          const spanStartMs = spanStartStr ? new Date(spanStartStr).getTime() : 0;

          // Extract agent name: "agent run: 'api-change-agent'" -> "api-change"
          const agentMatch = spanName.match(/agent run: '(.+?)-agent'/);
          const spanAgent = agentMatch ? agentMatch[1] : "";

          if (spanStartMs > 0) {
            for (const review of reviewIndex) {
              // Use a wider window that covers planner (before) and synthesis (after)
              if (spanStartMs < review.overallStart - WINDOW_BEFORE_MS ||
                  spanStartMs > review.overallEnd + WINDOW_AFTER_MS) {
                continue;
              }

              if (spanAgent) {
                // Try exact agent name + timestamp match (main agents)
                const agentMatched = review.agentWindows.some((aw) =>
                  aw.agent === spanAgent &&
                  Math.abs(aw.startMs - spanStartMs) < MATCH_TOLERANCE_MS,
                );
                if (agentMatched) {
                  assignedReviewId = review.reviewId;
                  break;
                }

                // For phases not in Redis traces (planner, verification, synthesis),
                // assign to the review if span time falls within the extended window
                const isExtraPhase = ["planner", "verification", "synthesis"].includes(spanAgent);
                if (isExtraPhase) {
                  assignedReviewId = review.reviewId;
                  break;
                }
              }
            }
          }
        }

        const key = assignedReviewId || "unlinked";
        let group = groups.get(key);
        if (!group) {
          group = [];
          groups.set(key, group);
        }
        group.push(span);
      }

      // ------------------------------------------------------------------
      // 3. Build response
      // ------------------------------------------------------------------
      const reviews = Array.from(groups.entries()).map(([reviewId, spans]) => {
        let earliest = Infinity;
        let latest = 0;
        const agents = spans.map((span) => {
          const st = toISOString(span.startedAt);
          const et = toISOString(span.endedAt);
          const startMs = st ? new Date(st).getTime() : Infinity;
          const endMs = et ? new Date(et).getTime() : 0;
          if (startMs < earliest) earliest = startMs;
          if (endMs > latest) latest = endMs;
          return {
            name: (span.name as string) ?? "",
            traceId: span.traceId as string,
            startTime: st,
            endTime: et,
            status: span.error ? "error" : et ? "success" : "running",
          };
        });

        agents.sort((a, b) => {
          const tA = a.startTime ? new Date(a.startTime).getTime() : 0;
          const tB = b.startTime ? new Date(b.startTime).getTime() : 0;
          return tA - tB;
        });

        return {
          reviewId,
          prUrl: prUrlMap.get(reviewId) ?? null,
          agentCount: agents.length,
          startTime: earliest !== Infinity ? new Date(earliest).toISOString() : null,
          endTime: latest > 0 ? new Date(latest).toISOString() : null,
          agents,
        };
      });

      // Sort reviews by most recent first, unlinked last
      reviews.sort((a, b) => {
        if (a.reviewId === "unlinked") return 1;
        if (b.reviewId === "unlinked") return -1;
        const tA = a.startTime ? new Date(a.startTime).getTime() : 0;
        const tB = b.startTime ? new Date(b.startTime).getTime() : 0;
        return tB - tA;
      });

      return { reviews };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to group traces by review");
      return { reviews: [] };
    }
  })

  /**
   * GET /api/traces?limit=50&reviewId=xxx
   */
  .get("/", async ({ query }) => {
    const limit = Math.min(parseInt((query as Record<string, string>).limit ?? "50", 10), 100);
    const reviewId = (query as Record<string, string>).reviewId;

    try {
      const observability = await getObservabilityStore();
      if (!observability) return { traces: [], total: 0 };

      const result = await observability.listTraces({
        pagination: { page: 0, perPage: limit },
        orderBy: { field: "startedAt", direction: "DESC" },
        ...(reviewId ? { filters: { metadata: { reviewId } } } : {}),
      });

      const traces = (result.spans ?? []).map((span: Record<string, unknown>) => ({
        id: span.traceId,
        name: span.name ?? null,
        scope: span.scope ?? null,
        startTime: toISOString(span.startedAt),
        endTime: toISOString(span.endedAt),
        attributes: span.attributes ?? null,
      }));

      return { traces, total: result.pagination?.total ?? traces.length };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to list traces");
      return { traces: [], total: 0 };
    }
  })

  /**
   * GET /api/traces/:traceId
   */
  .get("/:traceId", async ({ params }) => {
    const { traceId } = params;

    try {
      const observability = await getObservabilityStore();
      if (!observability) return { error: "Storage not configured" };

      const trace = await observability.getTrace({ traceId });
      if (!trace || !trace.spans || trace.spans.length === 0) {
        return { error: "Trace not found" };
      }

      const normalisedSpans = trace.spans.map((s: Record<string, unknown>) => normaliseSpan(s));
      const rootSpan = normalisedSpans.find((s: ReturnType<typeof normaliseSpan>) => !s.parentSpanId);

      return {
        traceId,
        rootSpan: rootSpan ?? null,
        spans: normalisedSpans,
        spanCount: normalisedSpans.length,
      };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error), traceId }, "Failed to get trace");
      return { error: "Failed to fetch trace" };
    }
  })

  /**
   * GET /api/traces/:traceId/spans
   */
  .get("/:traceId/spans", async ({ params }) => {
    const { traceId } = params;

    try {
      const observability = await getObservabilityStore();
      if (!observability) return { spans: [] };

      const trace = await observability.getTrace({ traceId });
      const rawSpans = trace?.spans ?? [];

      const normalisedSpans = rawSpans
        .map((s: Record<string, unknown>) => normaliseSpan(s))
        .sort((a: ReturnType<typeof normaliseSpan>, b: ReturnType<typeof normaliseSpan>) => {
          const tA = a.startTime ? new Date(a.startTime).getTime() : 0;
          const tB = b.startTime ? new Date(b.startTime).getTime() : 0;
          return tA - tB;
        });

      return { spans: normalisedSpans, total: normalisedSpans.length };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error), traceId }, "Failed to get spans");
      return { spans: [] };
    }
  });
