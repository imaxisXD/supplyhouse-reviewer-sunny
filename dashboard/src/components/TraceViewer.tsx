import { useState } from "react";
import { api, unwrap } from "../api/eden";
import { useReviewsList } from "../api/hooks";
import type { ReviewListItem, AgentTrace } from "../api/types";

const STATUS_BAR_COLORS: Record<string, string> = {
  success: "bg-emerald-500",
  failed: "bg-rose-500",
  skipped: "bg-warm-300",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  success: "text-emerald-700",
  failed: "text-rose-700",
  skipped: "text-ink-600",
};

export default function TraceViewer() {
  const { data, isLoading: loadingList, error: swrError } = useReviewsList(30);
  const reviews: ReviewListItem[] = data?.reviews ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [loadingTraces, setLoadingTraces] = useState(false);
  const [traceError, setTraceError] = useState("");
  const error = swrError?.message ?? traceError;

  const handleSelectReview = async (id: string) => {
    setSelectedId(id);
    setLoadingTraces(true);
    setTraces([]);
    setTraceError("");

    try {
      const result = await unwrap(api.api.review({ id }).result.get());
      setTraces((result as { traces?: AgentTrace[] }).traces ?? []);
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : "Failed to load traces");
    } finally {
      setLoadingTraces(false);
    }
  };

  const maxDuration =
    traces.length > 0 ? Math.max(...traces.map((t) => t.durationMs)) : 0;

  return (
    <div className="flex gap-6 min-h-[400px]">
      {/* Left panel - review list */}
      <div className="w-72 shrink-0">
        <h3 className="text-sm font-medium text-ink-700 mb-3">Recent Reviews</h3>
        {loadingList && (
          <p className="text-sm text-ink-600">Loading reviews...</p>
        )}
        {!loadingList && reviews.length === 0 && (
          <p className="text-sm text-ink-600">No reviews found.</p>
        )}
        <div className="space-y-1 max-h-[500px] overflow-y-auto">
          {reviews.map((review) => (
            <button
              key={review.id}
              onClick={() => handleSelectReview(review.id)}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors border ${
                selectedId === review.id
                  ? "bg-brand-500/10 border-brand-500/40 text-brand-700"
                  : "bg-white border-ink-900 text-ink-700 hover:bg-warm-100"
              }`}
            >
              <div className="font-mono text-xs truncate">{review.id}</div>
              <div className="flex items-center justify-between mt-1">
                <span
                  className={`text-xs ${
                    review.phase === "complete"
                      ? "text-emerald-700"
                      : review.phase === "failed"
                      ? "text-rose-700"
                      : "text-brand-600"
                  }`}
                >
                  {review.phase}
                </span>
                <span className="text-xs text-ink-600">
                  {review.totalFindings} findings
                </span>
              </div>
              <div className="text-xs text-ink-500 mt-0.5">
                {new Date(review.startedAt).toLocaleDateString()} {" "}
                {new Date(review.startedAt).toLocaleTimeString()}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel - waterfall trace view */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-ink-700 mb-3">Agent Trace Waterfall</h3>

        {!selectedId && (
          <div className="flex items-center justify-center h-64 text-ink-600 text-sm">
            Select a review from the left panel to view its agent traces.
          </div>
        )}

        {selectedId && loadingTraces && (
          <div className="flex items-center justify-center h-64 text-ink-600 text-sm">
            Loading traces...
          </div>
        )}

        {error && (
          <div className="p-3 bg-rose-50 border border-rose-300/70 text-sm text-rose-700 mb-4">
            {error}
          </div>
        )}

        {selectedId && !loadingTraces && traces.length === 0 && !error && (
          <div className="flex items-center justify-center h-64 text-ink-600 text-sm">
            No traces available for this review.
          </div>
        )}

        {traces.length > 0 && (
          <div className="space-y-2">
            {traces.map((trace) => {
              const widthPercent =
                maxDuration > 0 ? (trace.durationMs / maxDuration) * 100 : 0;
              return (
                <div
                  key={trace.agent}
                  className="bg-white border border-ink-900 p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink-900">
                        {trace.agent}
                      </span>
                      <span
                        className={`text-xs ${STATUS_TEXT_COLORS[trace.status] ?? "text-ink-600"}`}
                      >
                        {trace.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-ink-600">
                      {trace.toolUsage && (
                        <span className="flex items-center gap-1">
                          {trace.toolUsage.totalCalls > 0 ? (
                            <span title={Object.entries(trace.toolUsage.byTool).map(([t, c]) => `${t}: ${c}`).join(', ')}>
                              {trace.toolUsage.totalCalls} tool calls
                            </span>
                          ) : trace.findingsCount > 0 ? (
                            <span className="text-amber-600 font-medium" title="Agent reported findings without using any tools — findings may be speculative">
                              0 tools used
                            </span>
                          ) : (
                            <span>0 tools</span>
                          )}
                        </span>
                      )}
                      <span>
                        {(trace.durationMs / 1000).toFixed(1)}s
                      </span>
                      <span>
                        In: {trace.inputTokens.toLocaleString()} / Out: {trace.outputTokens.toLocaleString()}
                      </span>
                      <span>${trace.costUsd.toFixed(4)}</span>
                    </div>
                  </div>
                  <div className="w-full h-4 bg-warm-200 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        STATUS_BAR_COLORS[trace.status] ?? "bg-warm-300"
                      }`}
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
