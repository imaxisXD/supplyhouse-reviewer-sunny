import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMetrics, getReviewsList, getHealth, getReviewResult } from "../api/client";
import type { Metrics, ReviewListItem, AgentTrace } from "../api/client";
import { advanceJourneyStep } from "../journey";
import MastraTraceViewer from "../components/MastraTraceViewer";

type Tab = "overview" | "traces";

const panelClass =
  "border border-ink-900 bg-white p-4";
const panelTitleClass = "text-[10px] uppercase tracking-[0.35em] text-ink-600";
const statCardClass = "border border-ink-900 bg-white p-4";
const statLabelClass = "text-[10px] uppercase tracking-[0.3em] text-ink-600";
const statValueClass = "mt-2 text-xl font-semibold text-ink-950";
const tableHeaderClass = "px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-ink-600";
const tableRowClass = "border-t border-ink-900 hover:bg-warm-100/60 transition";
const tableCellClass = "px-4 py-3 text-ink-700";

export default function Observability() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reviews, setReviews] = useState<ReviewListItem[]>([]);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);

  useEffect(() => {
    void advanceJourneyStep("explore");
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
      <div className="border border-rose-400/50 bg-rose-50 p-5">
        <div className="text-rose-700 text-sm">{error}</div>
      </div>
    );
  }

  if (!metrics) {
    return <div className="text-ink-600 text-sm">Loading…</div>;
  }

  const maxTraceDuration = traces.length > 0 ? Math.max(...traces.map((t) => t.durationMs)) : 0;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Observability</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink-950">Observability</h1>
        <p className="mt-2 text-sm text-ink-700">System-wide metrics, recent reviews, and Mastra traces.</p>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-ink-900">
        <button
          onClick={() => setActiveTab("overview")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "overview"
              ? "border-b-2 border-brand-500 text-brand-700"
              : "text-ink-600 hover:text-ink-800"
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab("traces")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "traces"
              ? "border-b-2 border-brand-500 text-brand-700"
              : "text-ink-600 hover:text-ink-800"
          }`}
        >
          Mastra Traces
        </button>
      </div>

      {/* Mastra Traces Tab */}
      {activeTab === "traces" && <MastraTraceViewer />}

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={statCardClass}>
          <div className={statLabelClass}>Total Reviews</div>
          <div className={statValueClass}>{metrics.totalReviews}</div>
        </div>
        <div className={statCardClass}>
          <div className={statLabelClass}>Total Findings</div>
          <div className={`${statValueClass} text-brand-600`}>{metrics.totalFindings}</div>
        </div>
        <div className={statCardClass}>
          <div className={statLabelClass}>Avg Duration</div>
          <div className={statValueClass}>{(metrics.avgDurationMs / 1000).toFixed(1)}s</div>
        </div>
        <div className={statCardClass}>
          <div className={statLabelClass}>Total Cost</div>
          <div className={`${statValueClass} text-emerald-600`}>${metrics.totalCostUsd.toFixed(4)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className={panelClass}>
          <div className={panelTitleClass}>Severity Breakdown</div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries(metrics.severityCounts).map(([sev, count]) => (
              <div key={sev} className={statCardClass}>
                <div className={`${statLabelClass} capitalize`}>{sev}</div>
                <div className="mt-2 text-lg font-semibold text-ink-950">{count}</div>
              </div>
            ))}
          </div>
        </div>

        <div className={panelClass}>
          <div className={panelTitleClass}>Circuit Breakers</div>
          <div className="mt-4 space-y-2">
            {Object.entries(metrics.circuitBreakers).map(([name, state]) => {
              const tone =
                state.state === "OPEN"
                  ? "text-rose-700"
                  : state.state === "HALF_OPEN"
                  ? "text-amber-700"
                  : "text-emerald-700";
              return (
                <div
                  key={name}
                  className="flex items-center justify-between border border-ink-900 bg-warm-50 px-3 py-2 text-xs"
                >
                  <span className="text-ink-700">{name}</span>
                  <span className={tone}>
                    {state.state} ({state.failures})
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {health && (
        <div className={panelClass}>
          <div className={panelTitleClass}>Service Health</div>
          <div className="mt-4 flex items-center justify-between text-xs text-ink-700">
            <span>Status</span>
            <span className="text-ink-600">{(health.status as string) ?? "unknown"}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries((health.services as Record<string, boolean>) ?? {}).map(([name, ok]) => (
              <div key={name} className={statCardClass}>
                <div className={`${statLabelClass} capitalize`}>{name}</div>
                <div className={`text-sm font-semibold ${ok ? "text-emerald-700" : "text-rose-700"}`}>
                  {ok ? "healthy" : "down"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={panelClass}>
        <div className={panelTitleClass}>Recent Reviews</div>
        <p className="mt-2 text-xs text-ink-600">Click a review to view agent traces.</p>

        {reviews.length === 0 ? (
          <div className="mt-4 text-xs text-ink-600">No completed reviews available.</div>
        ) : (
          <div className="mt-4 overflow-hidden border border-ink-900">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className={tableHeaderClass}>Review</th>
                  <th className={`${tableHeaderClass} text-right`}>Findings</th>
                  <th className={`${tableHeaderClass} text-right`}>Duration</th>
                  <th className={`${tableHeaderClass} text-right`}>Cost</th>
                  <th className={`${tableHeaderClass} text-right`}>Traces</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => (
                  <Fragment key={review.id}>
                    <tr
                      className={`${tableRowClass} cursor-pointer`}
                      onClick={() => handleToggleTraces(review.id)}
                    >
                      <td className={`${tableCellClass} flex items-center gap-2`}>
                        <span className={`transition-transform ${expandedReview === review.id ? "rotate-90" : ""}`}>
                          ▶
                        </span>
                        <Link
                          to={`/review/${review.id}/results`}
                          className="font-mono text-[11px] text-brand-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {review.id.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{review.totalFindings}</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{(review.durationMs / 1000).toFixed(1)}s</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>${review.costUsd.toFixed(4)}</td>
                      <td className={`${tableCellClass} text-right text-ink-600`}>
                        {expandedReview === review.id ? "Hide" : "View"}
                      </td>
                    </tr>

                    {expandedReview === review.id && (
                      <tr key={`traces-${review.id}`} className={tableRowClass}>
                        <td colSpan={5} className="bg-warm-50 p-4">
                          {tracesLoading ? (
                            <p className="text-xs text-ink-600">Loading traces…</p>
                          ) : traces.length === 0 ? (
                            <p className="text-xs text-ink-600">No agent traces available.</p>
                          ) : (
                            <div className="space-y-3">
                              {traces.map((trace) => {
                                const widthPercent = maxTraceDuration > 0 ? (trace.durationMs / maxTraceDuration) * 100 : 0;
                                return (
                                  <div key={trace.agent} className="flex items-center gap-3">
                                    <span className="w-24 truncate text-right text-xs text-ink-600">
                                      {trace.agent}
                                    </span>
                                    <div className="flex-1 h-1.5 bg-warm-200">
                                      <div
                                        className={`h-full ${trace.status === "failed" ? "bg-rose-500" : "bg-brand-500"}`}
                                        style={{ width: `${widthPercent}%` }}
                                      />
                                    </div>
                                    <span className="w-12 text-xs tabular-nums text-ink-600">
                                      {(trace.durationMs / 1000).toFixed(1)}s
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}
