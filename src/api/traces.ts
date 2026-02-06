import { Elysia, t } from "elysia";
import { mastra } from "../mastra/index.ts";
import { redis } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import {
  TraceStatsResponseSchema,
  ReviewTraceGroupResponseSchema,
  TraceListResponseSchema,
  TraceDetailResponseSchema,
  SpansResponseSchema,
  ErrorResponse,
} from "./schemas.ts";

const log = createLogger("api:traces");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getObservabilityStore() {
  const storage = mastra.getStorage();
  if (!storage) return null;
  return storage.getStore("observability");
}

function toISOString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return null;
}

/**
 * Paginate through all root spans in the observability store.
 * Mastra's perPage is capped at 100, and orderBy is required.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collectAllRootSpans(observability: any): Promise<Record<string, unknown>[]> {
  const allSpans: Record<string, unknown>[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const result = await observability.listTraces({ page, perPage, orderBy: { startedAt: "desc" } });
    const spans = result.spans || [];
    allSpans.push(...spans);
    if (spans.length < perPage) break;
    page++;
    if (page > 20) break; // safety limit: max 2000 spans
  }

  return allSpans;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * API routes for Mastra observability traces.
 * Exposes trace data from the LibSQL storage for the dashboard UI.
 */
export const traceRoutes = new Elysia({ prefix: "/api/traces" })
  /**
   * Get trace statistics for the dashboard.
   * GET /api/traces/stats
   *
   * Note: This route must be defined before /:traceId to avoid route conflicts
   */
  .get("/stats", async () => {
    try {
      const observability = await getObservabilityStore();
      if (!observability) {
        return { totalTraces: 0, totalSpans: 0, avgDurationMs: 0, spanTypeCount: {} };
      }

      const allSpans = await collectAllRootSpans(observability);

      // Compute stats from root spans
      let totalSpans = 0;
      let totalDurationMs = 0;
      const spanTypeCount: Record<string, number> = {};

      for (const span of allSpans) {
        totalSpans += 1;
        const type = (span.name as string) || "unknown";
        spanTypeCount[type] = (spanTypeCount[type] || 0) + 1;

        const startStr = toISOString(span.startedAt);
        const endStr = toISOString(span.endedAt);
        if (startStr && endStr) {
          const start = new Date(startStr).getTime();
          const end = new Date(endStr).getTime();
          totalDurationMs += end - start;
        }
      }

      return {
        totalTraces: allSpans.length,
        totalSpans,
        avgDurationMs: totalSpans > 0 ? Math.round(totalDurationMs / totalSpans) : 0,
        spanTypeCount,
      };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to get trace stats");
      return {
        totalTraces: 0,
        totalSpans: 0,
        avgDurationMs: 0,
        spanTypeCount: {},
      };
    }
  }, { response: TraceStatsResponseSchema })

  /**
   * GET /api/traces/by-review
   * Groups root spans by reviewId (stored in metadata.reviewId via tracingOptions).
   * For legacy spans without metadata.reviewId, correlates them to reviews
   * stored in Redis by matching agent start times (+/-5 s window).
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
            const agentWindows: { agent: string; startMs: number; endMs: number }[] = [];
            for (const tr of traces) {
              const s = tr.startedAt ? new Date(tr.startedAt).getTime() : NaN;
              const e = tr.completedAt ? new Date(tr.completedAt).getTime() : NaN;
              if (!Number.isFinite(s) || s <= 0) continue;
              if (s < overallStart) overallStart = s;
              if (Number.isFinite(e) && e > overallEnd) overallEnd = e;
              agentWindows.push({ agent: tr.agent, startMs: s, endMs: Number.isFinite(e) ? e : s });
            }

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
      const MATCH_TOLERANCE_MS = 5_000;
      const WINDOW_BEFORE_MS = 5 * 60_000;
      const WINDOW_AFTER_MS = 5 * 60_000;
      const groups = new Map<string, Record<string, unknown>[]>();
      const prUrlMap = new Map<string, string | undefined>();

      for (const review of reviewIndex) {
        prUrlMap.set(review.reviewId, review.prUrl);
      }

      for (const span of allSpans) {
        const meta = span.metadata as Record<string, unknown> | null | undefined;
        let assignedReviewId = (meta?.reviewId as string) || "";

        if (!assignedReviewId) {
          const spanName = ((span.name as string) || "").toLowerCase();
          const spanStartStr = toISOString(span.startedAt);
          const spanStartMs = spanStartStr ? new Date(spanStartStr).getTime() : 0;
          const agentMatch = spanName.match(/agent run: '(.+?)-agent'/);
          const spanAgent = agentMatch ? agentMatch[1] : "";

          if (spanStartMs > 0) {
            for (const review of reviewIndex) {
              if (spanStartMs < review.overallStart - WINDOW_BEFORE_MS ||
                  spanStartMs > review.overallEnd + WINDOW_AFTER_MS) {
                continue;
              }

              if (spanAgent) {
                const agentMatched = review.agentWindows.some((aw) =>
                  aw.agent === spanAgent &&
                  Math.abs(aw.startMs - spanStartMs) < MATCH_TOLERANCE_MS,
                );
                if (agentMatched) {
                  assignedReviewId = review.reviewId;
                  break;
                }

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
  }, { response: ReviewTraceGroupResponseSchema })

  /**
   * List traces with optional filtering.
   * GET /api/traces?limit=50&name=agent_run&reviewId=xxx
   */
  .get("/", async ({ query }) => {
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 100);
    const name = query.name;

    try {
      const observability = await getObservabilityStore();
      if (!observability) {
        return { traces: [], total: 0, error: "Storage not configured" };
      }

      // Fetch root spans using Mastra's observability storage API
      const result = await observability.listTraces({
        perPage: limit,
        page: 1,
        orderBy: { startedAt: "desc" },
        ...(name ? { name } : {}),
      });

      const spans = result.spans || [];

      // Transform root spans to a simpler trace format for the API
      const traces = spans.map((span: Record<string, unknown>) => ({
        id: span.traceId ?? span.spanId,
        name: span.name,
        scope: span.scope,
        startTime: toISOString(span.startedAt),
        endTime: toISOString(span.endedAt),
        attributes: span.attributes,
      }));

      return { traces, total: traces.length };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to list traces");
      return { traces: [], total: 0, error: "Failed to fetch traces" };
    }
  }, {
    query: t.Object({
      limit: t.Optional(t.String()),
      name: t.Optional(t.String()),
      reviewId: t.Optional(t.String()),
      startDate: t.Optional(t.String()),
      endDate: t.Optional(t.String()),
    }),
    response: TraceListResponseSchema,
  })

  /**
   * Get a single trace by ID with all its spans.
   * GET /api/traces/:traceId
   */
  .get("/:traceId", async ({ params, set }) => {
    const { traceId } = params;

    try {
      const observability = await getObservabilityStore();
      if (!observability) {
        set.status = 404;
        return { error: "Storage not configured" };
      }

      const trace = await observability.getTrace({ traceId });

      if (!trace || !trace.spans || trace.spans.length === 0) {
        set.status = 404;
        return { error: "Trace not found" };
      }

      const rootSpan = trace.spans.find((s: { parentSpanId?: string }) => !s.parentSpanId);

      return {
        traceId,
        rootSpan,
        spans: trace.spans,
        spanCount: trace.spans.length,
      };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error), traceId }, "Failed to get trace");
      set.status = 500;
      return { error: "Failed to fetch trace" };
    }
  }, {
    response: {
      200: TraceDetailResponseSchema,
      404: ErrorResponse,
      500: ErrorResponse,
    },
  })

  /**
   * Get all spans for a trace.
   * GET /api/traces/:traceId/spans
   */
  .get("/:traceId/spans", async ({ params }) => {
    const { traceId } = params;

    try {
      const observability = await getObservabilityStore();
      if (!observability) {
        return { spans: [], error: "Storage not configured" };
      }

      const trace = await observability.getTrace({ traceId });
      const spans = trace?.spans || [];

      // Sort spans by start time for timeline visualization
      const sortedSpans = [...spans].sort((a, b) => {
        const startA = typeof a.startTime === "number" ? a.startTime : new Date(a.startTime).getTime();
        const startB = typeof b.startTime === "number" ? b.startTime : new Date(b.startTime).getTime();
        return startA - startB;
      });

      return { spans: sortedSpans, total: sortedSpans.length };
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error), traceId },
        "Failed to get spans"
      );
      return { spans: [], error: "Failed to fetch spans" };
    }
  }, { response: SpansResponseSchema });
