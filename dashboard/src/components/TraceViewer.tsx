import { useEffect, useState } from "react";
import { getReviewsList, getReviewResult } from "../api/client";
import type { ReviewListItem, AgentTrace } from "../api/client";

const STATUS_BAR_COLORS: Record<string, string> = {
  success: "bg-green-600",
  failed: "bg-red-600",
  skipped: "bg-gray-600",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  success: "text-green-400",
  failed: "text-red-400",
  skipped: "text-gray-400",
};

export default function TraceViewer() {
  const [reviews, setReviews] = useState<ReviewListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingTraces, setLoadingTraces] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getReviewsList(30)
      .then((data) => {
        setReviews(data.reviews);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingList(false));
  }, []);

  const handleSelectReview = async (id: string) => {
    setSelectedId(id);
    setLoadingTraces(true);
    setTraces([]);
    setError("");

    try {
      const result = await getReviewResult(id);
      setTraces(result.traces ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load traces");
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
        <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Reviews</h3>
        {loadingList && (
          <p className="text-sm text-gray-600">Loading reviews...</p>
        )}
        {!loadingList && reviews.length === 0 && (
          <p className="text-sm text-gray-600">No reviews found.</p>
        )}
        <div className="space-y-1 max-h-[500px] overflow-y-auto">
          {reviews.map((review) => (
            <button
              key={review.id}
              onClick={() => handleSelectReview(review.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                selectedId === review.id
                  ? "bg-blue-900/40 border border-blue-800 text-blue-300"
                  : "bg-gray-900 border border-gray-800 text-gray-300 hover:bg-gray-800/70"
              }`}
            >
              <div className="font-mono text-xs truncate">{review.id}</div>
              <div className="flex items-center justify-between mt-1">
                <span
                  className={`text-xs ${
                    review.phase === "complete"
                      ? "text-green-400"
                      : review.phase === "failed"
                      ? "text-red-400"
                      : "text-blue-400"
                  }`}
                >
                  {review.phase}
                </span>
                <span className="text-xs text-gray-500">
                  {review.totalFindings} findings
                </span>
              </div>
              <div className="text-xs text-gray-600 mt-0.5">
                {new Date(review.startedAt).toLocaleDateString()}{" "}
                {new Date(review.startedAt).toLocaleTimeString()}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel - waterfall trace view */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Agent Trace Waterfall</h3>

        {!selectedId && (
          <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
            Select a review from the left panel to view its agent traces.
          </div>
        )}

        {selectedId && loadingTraces && (
          <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
            Loading traces...
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300 mb-4">
            {error}
          </div>
        )}

        {selectedId && !loadingTraces && traces.length === 0 && !error && (
          <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
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
                  className="bg-gray-900 border border-gray-800 rounded-lg p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-200">
                        {trace.agent}
                      </span>
                      <span
                        className={`text-xs ${STATUS_TEXT_COLORS[trace.status] ?? "text-gray-400"}`}
                      >
                        {trace.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span>
                        {(trace.durationMs / 1000).toFixed(1)}s
                      </span>
                      <span>
                        In: {trace.inputTokens.toLocaleString()} / Out: {trace.outputTokens.toLocaleString()}
                      </span>
                      <span>${trace.costUsd.toFixed(4)}</span>
                    </div>
                  </div>
                  <div className="w-full h-4 bg-gray-800 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all duration-500 ${
                        STATUS_BAR_COLORS[trace.status] ?? "bg-gray-600"
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
