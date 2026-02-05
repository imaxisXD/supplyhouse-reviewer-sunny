import { Elysia } from "elysia";
import { mastra } from "../mastra/index.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("api:traces");

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
      const storage = mastra.getStorage();
      if (!storage) {
        return { error: "Storage not configured" };
      }

      const observability = await storage.getStore("observability");
      if (!observability) {
        return { error: "Observability store not available" };
      }

      // Get recent traces for stats
      const result = await observability.listTraces({ limit: 100 });
      const traces = result.rootSpans || [];

      // Compute stats from root spans
      let totalSpans = 0;
      let totalDurationMs = 0;
      const spanTypeCount: Record<string, number> = {};

      for (const trace of traces) {
        totalSpans += 1;
        const type = trace.name || "unknown";
        spanTypeCount[type] = (spanTypeCount[type] || 0) + 1;

        if (trace.startTime && trace.endTime) {
          const start = typeof trace.startTime === "number" ? trace.startTime : new Date(trace.startTime).getTime();
          const end = typeof trace.endTime === "number" ? trace.endTime : new Date(trace.endTime).getTime();
          totalDurationMs += end - start;
        }
      }

      return {
        totalTraces: traces.length,
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
  })

  /**
   * List traces with optional filtering.
   * GET /api/traces?limit=50&name=agent_run&startDate=2024-01-01&endDate=2024-01-31
   */
  .get("/", async ({ query }) => {
    const limit = Math.min(parseInt((query as Record<string, string>).limit ?? "50", 10), 200);
    const name = (query as Record<string, string>).name;

    try {
      const storage = mastra.getStorage();
      if (!storage) {
        return { traces: [], total: 0, error: "Storage not configured" };
      }

      const observability = await storage.getStore("observability");
      if (!observability) {
        return { traces: [], total: 0, error: "Observability store not available" };
      }

      // Fetch traces using Mastra's observability storage API
      const result = await observability.listTraces({
        limit,
        ...(name ? { name } : {}),
      });

      // Transform root spans to a simpler trace format for the API
      const traces = (result.rootSpans || []).map((span: { traceId: string; name?: string; scope?: string; startTime?: number | string; endTime?: number | string; attributes?: Record<string, unknown> }) => ({
        id: span.traceId,
        name: span.name,
        scope: span.scope,
        startTime: span.startTime,
        endTime: span.endTime,
        attributes: span.attributes,
      }));

      return { traces, total: traces.length };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to list traces");
      return { traces: [], total: 0, error: "Failed to fetch traces" };
    }
  })

  /**
   * Get a single trace by ID with all its spans.
   * GET /api/traces/:traceId
   */
  .get("/:traceId", async ({ params }) => {
    const { traceId } = params;

    try {
      const storage = mastra.getStorage();
      if (!storage) {
        return { error: "Storage not configured" };
      }

      const observability = await storage.getStore("observability");
      if (!observability) {
        return { error: "Observability store not available" };
      }

      // Get the trace with its spans
      const trace = await observability.getTrace({ traceId });

      if (!trace || !trace.spans || trace.spans.length === 0) {
        return { error: "Trace not found" };
      }

      // Find the root span (no parentSpanId)
      const rootSpan = trace.spans.find((s: { parentSpanId?: string }) => !s.parentSpanId);

      return {
        traceId,
        rootSpan,
        spans: trace.spans,
        spanCount: trace.spans.length,
      };
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error), traceId },
        "Failed to get trace"
      );
      return { error: "Failed to fetch trace" };
    }
  })

  /**
   * Get all spans for a trace.
   * GET /api/traces/:traceId/spans
   */
  .get("/:traceId/spans", async ({ params }) => {
    const { traceId } = params;

    try {
      const storage = mastra.getStorage();
      if (!storage) {
        return { spans: [], error: "Storage not configured" };
      }

      const observability = await storage.getStore("observability");
      if (!observability) {
        return { spans: [], error: "Observability store not available" };
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
  });
