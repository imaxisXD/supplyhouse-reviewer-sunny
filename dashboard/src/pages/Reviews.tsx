import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getReviewsList } from "../api/client";
import type { ReviewListItem } from "../api/client";

type FilterValue = "all" | "complete" | "failed" | "in-progress" | "queued";

const ACTIVE_PHASES = new Set(["queued", "fetching-pr", "building-context", "running-agents", "synthesizing", "posting-comments", "cancelling"]);

const statCardClass = "border border-ink-900 bg-white p-4";
const statLabelClass = "text-[10px] uppercase tracking-[0.3em] text-ink-600";
const statValueClass = "mt-2 text-xl font-semibold text-ink-950";
const tableHeaderClass = "px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-ink-600";
const tableRowClass = "border-t border-ink-900 hover:bg-warm-100/60 transition";
const tableCellClass = "px-4 py-3 text-ink-700";

function phaseToBucket(phase: string): FilterValue {
  if (phase === "complete") return "complete";
  if (phase === "failed") return "failed";
  if (phase === "queued") return "queued";
  return "in-progress";
}

function StatusBadge({ phase }: { phase: string }) {
  const bucket = phaseToBucket(phase);
  const styles: Record<FilterValue, string> = {
    complete: "bg-emerald-100 text-emerald-800 border-emerald-300",
    failed: "bg-rose-100 text-rose-800 border-rose-300",
    "in-progress": "bg-amber-100 text-amber-800 border-amber-300",
    queued: "bg-ink-100 text-ink-700 border-ink-300",
    all: "",
  };
  const labels: Record<string, string> = {
    complete: "Complete",
    failed: "Failed",
    queued: "Queued",
    "fetching-pr": "Fetching PR",
    "building-context": "Building Context",
    "running-agents": "Running Agents",
    "synthesizing": "Synthesizing",
    "posting-comments": "Posting Comments",
    cancelling: "Cancelling",
  };
  return (
    <span className={`inline-block border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] font-semibold ${styles[bucket]}`}>
      {labels[phase] ?? phase}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "-";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function Reviews() {
  const [reviews, setReviews] = useState<ReviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchReviews = useCallback(async () => {
    try {
      const res = await getReviewsList(100);
      setReviews(res.reviews ?? []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchReviews();
  }, [fetchReviews]);

  // Auto-poll when there are active reviews
  useEffect(() => {
    const hasActive = reviews.some((r) => ACTIVE_PHASES.has(r.phase));
    if (hasActive) {
      pollRef.current = setInterval(() => void fetchReviews(), 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [reviews, fetchReviews]);

  const filtered = filter === "all" ? reviews : reviews.filter((r) => phaseToBucket(r.phase) === filter);

  const counts = {
    total: reviews.length,
    complete: reviews.filter((r) => r.phase === "complete").length,
    failed: reviews.filter((r) => r.phase === "failed").length,
    active: reviews.filter((r) => ACTIVE_PHASES.has(r.phase) && r.phase !== "queued").length,
    queued: reviews.filter((r) => r.phase === "queued").length,
  };

  if (error && loading) {
    return (
      <div className="border border-rose-400/50 bg-rose-50 p-5">
        <div className="text-rose-700 text-sm">{error}</div>
      </div>
    );
  }

  if (loading) {
    return <div className="text-ink-600 text-sm">Loading...</div>;
  }

  const filters: { value: FilterValue; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.total },
    { value: "complete", label: "Completed", count: counts.complete },
    { value: "failed", label: "Failed", count: counts.failed },
    { value: "in-progress", label: "In Progress", count: counts.active },
    { value: "queued", label: "Queued", count: counts.queued },
  ];

  function linkForReview(r: ReviewListItem): string {
    if (r.phase === "complete") return `/review/${r.id}/results`;
    return `/review/${r.id}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Reviews</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink-950">Reviews</h1>
        <p className="mt-2 text-sm text-ink-700">All submitted reviews and their current status.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={statCardClass}>
          <div className={statLabelClass}>Total</div>
          <div className={statValueClass}>{counts.total}</div>
        </div>
        <div className={statCardClass}>
          <div className={statLabelClass}>Completed</div>
          <div className={`${statValueClass} text-emerald-600`}>{counts.complete}</div>
        </div>
        <div className={statCardClass}>
          <div className={statLabelClass}>Failed</div>
          <div className={`${statValueClass} text-rose-600`}>{counts.failed}</div>
        </div>
        <div className={statCardClass}>
          <div className={statLabelClass}>In Progress</div>
          <div className={`${statValueClass} text-amber-600`}>{counts.active + counts.queued}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`border px-3 py-1.5 text-[10px] uppercase tracking-[0.3em] font-semibold transition ${
              filter === f.value
                ? "border-ink-950 bg-ink-950 text-white"
                : "border-ink-900 bg-white text-ink-700 hover:bg-warm-100"
            }`}
          >
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      {error && (
        <div className="border border-rose-400/50 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="border border-ink-900 bg-white p-6 text-center text-sm text-ink-600">
          {reviews.length === 0 ? "No reviews yet. Submit your first review to get started." : "No reviews match the selected filter."}
        </div>
      ) : (
        <div className="overflow-hidden border border-ink-900">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className={tableHeaderClass}>Review</th>
                <th className={tableHeaderClass}>PR</th>
                <th className={tableHeaderClass}>Status</th>
                <th className={`${tableHeaderClass} text-right`}>Findings</th>
                <th className={`${tableHeaderClass} text-right`}>Duration</th>
                <th className={`${tableHeaderClass} text-right`}>Cost</th>
                <th className={tableHeaderClass}>Started</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((review) => (
                <Fragment key={review.id}>
                  <tr className={`${tableRowClass} ${review.phase === "failed" && review.error ? "cursor-pointer" : ""}`}
                    onClick={() => {
                      if (review.phase === "failed" && review.error) {
                        setExpandedError(expandedError === review.id ? null : review.id);
                      }
                    }}
                  >
                    <td className={`${tableCellClass} flex items-center gap-2`}>
                      {review.phase === "failed" && review.error && (
                        <span className={`text-[10px] transition-transform ${expandedError === review.id ? "rotate-90" : ""}`}>
                          &#9654;
                        </span>
                      )}
                      <Link
                        to={linkForReview(review)}
                        className="font-mono text-[11px] text-brand-600 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {review.id.slice(0, 8)}...
                      </Link>
                    </td>
                    <td className={tableCellClass}>
                      {review.prUrl ? (
                        <a
                          href={review.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline truncate block max-w-[180px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {review.prUrl.replace(/^https?:\/\/bitbucket\.org\//, "").replace(/\/pull-requests\//, " #")}
                        </a>
                      ) : (
                        <span className="text-ink-500">-</span>
                      )}
                    </td>
                    <td className={tableCellClass}>
                      <StatusBadge phase={review.phase} />
                    </td>
                    <td className={`${tableCellClass} text-right tabular-nums`}>
                      {review.phase === "complete" ? review.totalFindings : "-"}
                    </td>
                    <td className={`${tableCellClass} text-right tabular-nums`}>
                      {formatDuration(review.durationMs)}
                    </td>
                    <td className={`${tableCellClass} text-right tabular-nums`}>
                      {review.costUsd > 0 ? `$${review.costUsd.toFixed(4)}` : "-"}
                    </td>
                    <td className={`${tableCellClass} text-ink-600`}>
                      {formatDate(review.startedAt)}
                    </td>
                  </tr>

                  {expandedError === review.id && review.error && (
                    <tr className={tableRowClass}>
                      <td colSpan={7} className="bg-rose-50 px-6 py-3">
                        <div className="text-[10px] uppercase tracking-[0.3em] text-rose-600 font-semibold mb-1">Error</div>
                        <div className="text-xs text-rose-800 font-mono whitespace-pre-wrap break-all">{review.error}</div>
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
  );
}
