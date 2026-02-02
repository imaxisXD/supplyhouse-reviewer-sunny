import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMetrics, getReviewsList, getHealth, getReviewResult } from "../api/client";
import type { Metrics, ReviewListItem, AgentTrace } from "../api/client";

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-600",
  failed: "bg-red-600",
  skipped: "bg-gray-600",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  success: "text-green-400",
  failed: "text-red-400",
  skipped: "text-gray-400",
};

export default function Observability() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reviews, setReviews] = useState<ReviewListItem[]>([]);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);

  useEffect(() => {
    Promise.all([getMetrics(), getReviewsList(20), getHealth()])
      .then(([metricsRes, reviewsRes, healthRes]) => {
        setMetrics(metricsRes);
        setReviews(reviewsRes.reviews ?? []);
        setHealth(healthRes);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load metrics"));
  }, []);

  const handleToggleTraces = async (reviewId: string) => {
    if (expandedReview === reviewId) {
      setExpandedReview(null);
      setTraces([]);
      return;
    }
    setExpandedReview(reviewId);
    setTracesLoading(true);
    try {
      const result = await getReviewResult(reviewId);
      setTraces(result.traces ?? []);
    } catch {
      setTraces([]);
    } finally {
      setTracesLoading(false);
    }
  };

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!metrics) {
    return <div className="text-center py-16 text-gray-500">Loading observability...</div>;
  }

  const maxTraceDuration = traces.length > 0 ? Math.max(...traces.map((t) => t.durationMs)) : 0;

  // Compute waterfall offsets from startedAt times
  const waterfallData = traces.length > 0
    ? (() => {
        const starts = traces.map((t) => new Date(t.startedAt).getTime());
        const ends = traces.map((t) => new Date(t.completedAt).getTime());
        const minStart = Math.min(...starts);
        const maxEnd = Math.max(...ends);
        const totalSpan = maxEnd - minStart || 1;
        return traces.map((t, i) => ({
          agent: t.agent,
          status: t.status,
          durationMs: t.durationMs,
          offsetPercent: ((starts[i]! - minStart) / totalSpan) * 100,
          widthPercent: Math.max(((ends[i]! - starts[i]!) / totalSpan) * 100, 1),
        }));
      })()
    : [];

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Observability</h1>
      <p className="text-gray-400 mb-8">System-wide metrics, recent reviews, and breaker states.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Reviews</p>
          <p className="text-2xl font-bold text-white">{metrics.totalReviews}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Findings</p>
          <p className="text-2xl font-bold text-blue-400">{metrics.totalFindings}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Avg Duration</p>
          <p className="text-2xl font-bold text-purple-400">
            {(metrics.avgDurationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Cost</p>
          <p className="text-2xl font-bold text-emerald-400">
            ${metrics.totalCostUsd.toFixed(4)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Severity Breakdown</h2>
          <div className="grid grid-cols-3 gap-3 text-sm">
            {Object.entries(metrics.severityCounts).map(([sev, count]) => (
              <div key={sev} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-500 capitalize">{sev}</p>
                <p className="text-lg font-semibold text-gray-200">{count}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Circuit Breakers</h2>
          <div className="space-y-2">
            {Object.entries(metrics.circuitBreakers).map(([name, state]) => (
              <div
                key={name}
                className="flex items-center justify-between text-sm bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2"
              >
                <span className="text-gray-300">{name}</span>
                <span className={`text-xs ${state.state === "OPEN" ? "text-red-400" : state.state === "HALF_OPEN" ? "text-yellow-400" : "text-green-400"}`}>
                  {state.state} ({state.failures})
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {health && (
        <div className="mb-10">
          <h2 className="text-lg font-semibold mb-4">Service Health</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-300">Status</span>
              <span className="text-xs text-gray-400">
                {(health.status as string) ?? "unknown"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              {Object.entries((health.services as Record<string, boolean>) ?? {}).map(([name, ok]) => (
                <div key={name} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-500 capitalize">{name}</p>
                  <p className={`text-sm font-semibold ${ok ? "text-green-400" : "text-red-400"}`}>
                    {ok ? "healthy" : "down"}
                  </p>
                </div>
              ))}
            </div>
            {health.degradation && (
              <div className="text-xs text-gray-500">
                Degradation: {JSON.stringify(health.degradation)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-4">Recent Reviews</h2>
        <p className="text-sm text-gray-500 mb-3">Click a review to view agent traces and waterfall timeline.</p>
        {reviews.length === 0 ? (
          <div className="text-sm text-gray-500">No completed reviews available.</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_100px_100px_100px_60px] gap-2 px-4 py-2 border-b border-gray-800 text-xs text-gray-500">
              <span>Review</span>
              <span className="text-right">Findings</span>
              <span className="text-right">Duration</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Traces</span>
            </div>
            {reviews.map((review) => (
              <div key={review.id}>
                <div
                  className="grid grid-cols-[1fr_100px_100px_100px_60px] gap-2 px-4 py-2.5 border-b border-gray-800/50 text-sm hover:bg-gray-800/30 transition-colors cursor-pointer"
                  onClick={() => handleToggleTraces(review.id)}
                >
                  <span className="text-gray-200 font-mono text-xs truncate flex items-center gap-2">
                    <span className={`transition-transform ${expandedReview === review.id ? "rotate-90" : ""}`}>
                      &#9654;
                    </span>
                    <Link
                      to={`/review/${review.id}/results`}
                      className="hover:text-blue-400 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {review.id}
                    </Link>
                  </span>
                  <span className="text-right text-gray-400 font-mono text-xs">
                    {review.totalFindings}
                  </span>
                  <span className="text-right text-gray-400 font-mono text-xs">
                    {(review.durationMs / 1000).toFixed(1)}s
                  </span>
                  <span className="text-right text-gray-400 font-mono text-xs">
                    ${review.costUsd.toFixed(4)}
                  </span>
                  <span className="text-right text-gray-500 text-xs">
                    {expandedReview === review.id ? "Hide" : "View"}
                  </span>
                </div>

                {/* Expanded trace viewer */}
                {expandedReview === review.id && (
                  <div className="px-4 py-4 border-b border-gray-800/50 bg-gray-950/50">
                    {tracesLoading ? (
                      <p className="text-sm text-gray-500">Loading traces...</p>
                    ) : traces.length === 0 ? (
                      <p className="text-sm text-gray-500">No agent traces available for this review.</p>
                    ) : (
                      <div className="space-y-6">
                        {/* Agent trace table */}
                        <div>
                          <h3 className="text-sm font-medium text-gray-400 mb-2">Agent Traces</h3>
                          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                            <div className="grid grid-cols-[1fr_70px_70px_70px_70px_70px] gap-2 px-3 py-1.5 border-b border-gray-800 text-xs text-gray-500">
                              <span>Agent</span>
                              <span className="text-right">Status</span>
                              <span className="text-right">Duration</span>
                              <span className="text-right">In Tokens</span>
                              <span className="text-right">Out Tokens</span>
                              <span className="text-right">Cost</span>
                            </div>
                            {traces.map((trace) => (
                              <div
                                key={trace.agent}
                                className="grid grid-cols-[1fr_70px_70px_70px_70px_70px] gap-2 px-3 py-2 border-b border-gray-800/50 text-xs hover:bg-gray-800/20"
                              >
                                <span className="text-gray-200 font-medium">{trace.agent}</span>
                                <span className="text-right">
                                  <span className={`inline-flex items-center gap-1 ${STATUS_TEXT_COLORS[trace.status] ?? "text-gray-400"}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[trace.status] ?? "bg-gray-500"}`} />
                                    {trace.status}
                                  </span>
                                </span>
                                <span className="text-right text-gray-300 font-mono">
                                  {(trace.durationMs / 1000).toFixed(1)}s
                                </span>
                                <span className="text-right text-gray-400 font-mono">
                                  {trace.inputTokens.toLocaleString()}
                                </span>
                                <span className="text-right text-gray-400 font-mono">
                                  {trace.outputTokens.toLocaleString()}
                                </span>
                                <span className="text-right text-gray-400 font-mono">
                                  ${trace.costUsd.toFixed(4)}
                                </span>
                              </div>
                            ))}
                          </div>
                          {traces.some((t) => t.error) && (
                            <div className="mt-2 space-y-1">
                              {traces
                                .filter((t) => t.error)
                                .map((t) => (
                                  <div
                                    key={`err-${t.agent}`}
                                    className="text-xs text-red-300 bg-red-900/20 border border-red-800/50 rounded px-2 py-1"
                                  >
                                    <span className="font-medium">{t.agent}:</span> {t.error}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>

                        {/* Waterfall timeline */}
                        <div>
                          <h3 className="text-sm font-medium text-gray-400 mb-2">Waterfall Timeline</h3>
                          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-1.5">
                            {waterfallData.map((entry) => (
                              <div key={`wf-${entry.agent}`} className="flex items-center gap-2">
                                <span className="text-xs text-gray-400 w-24 shrink-0 text-right truncate">
                                  {entry.agent}
                                </span>
                                <div className="flex-1 h-5 bg-gray-800 rounded overflow-hidden relative">
                                  <div
                                    className={`absolute top-0 h-full rounded transition-all ${STATUS_COLORS[entry.status] ?? "bg-gray-600"}`}
                                    style={{
                                      left: `${entry.offsetPercent}%`,
                                      width: `${entry.widthPercent}%`,
                                    }}
                                    title={`${entry.agent}: ${(entry.durationMs / 1000).toFixed(1)}s`}
                                  />
                                </div>
                                <span className="text-xs text-gray-500 font-mono w-14 shrink-0">
                                  {(entry.durationMs / 1000).toFixed(1)}s
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Relative duration bars */}
                        <div>
                          <h3 className="text-sm font-medium text-gray-400 mb-2">Relative Duration</h3>
                          <div className="space-y-1.5">
                            {traces.map((trace) => {
                              const widthPercent =
                                maxTraceDuration > 0 ? (trace.durationMs / maxTraceDuration) * 100 : 0;
                              return (
                                <div key={`bar-${trace.agent}`} className="flex items-center gap-2">
                                  <span className="text-xs text-gray-400 w-24 shrink-0 text-right truncate">
                                    {trace.agent}
                                  </span>
                                  <div className="flex-1 h-5 bg-gray-800 rounded overflow-hidden">
                                    <div
                                      className={`h-full rounded transition-all duration-500 ${STATUS_COLORS[trace.status] ?? "bg-gray-600"}`}
                                      style={{ width: `${widthPercent}%` }}
                                    />
                                  </div>
                                  <span className="text-xs text-gray-500 font-mono w-14 shrink-0">
                                    {(trace.durationMs / 1000).toFixed(1)}s
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
