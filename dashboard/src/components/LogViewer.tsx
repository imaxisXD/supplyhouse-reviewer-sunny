import { useEffect, useState } from "react";
import { getReviewsList } from "../api/client";
import type { ReviewListItem } from "../api/client";

type LogLevel = "all" | "info" | "warning" | "error";

function getLogLevel(review: ReviewListItem): "info" | "warning" | "error" {
  if (review.phase === "failed") return "error";
  if (review.phase === "complete") return "info";
  // In-progress phases
  return "info";
}

const LEVEL_COLORS: Record<string, string> = {
  info: "text-brand-600",
  warning: "text-amber-700",
  error: "text-rose-700",
};

const LEVEL_BG: Record<string, string> = {
  info: "bg-brand-500/10 border-brand-500/30",
  warning: "bg-amber-50 border-amber-300/70",
  error: "bg-rose-50 border-rose-300/70",
};

const inputClass =
  "w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500";

export default function LogViewer() {
  const [reviews, setReviews] = useState<ReviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<LogLevel>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    getReviewsList(100)
      .then((data) => setReviews(data.reviews))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = reviews.filter((review) => {
    const level = getLogLevel(review);
    if (filter !== "all" && level !== filter) return false;
    if (search && !review.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const filterButtons: { key: LogLevel; label: string }[] = [
    { key: "all", label: "All" },
    { key: "info", label: "Info" },
    { key: "warning", label: "Warning" },
    { key: "error", label: "Error" },
  ];

  if (loading) {
    return <div className="text-center py-12 text-ink-600">Loading logs...</div>;
  }

  if (error) {
    return (
      <div className="p-4 bg-rose-50 border border-rose-300/70 text-rose-700 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex gap-1">
          {filterButtons.map((btn) => (
            <button
              key={btn.key}
              onClick={() => setFilter(btn.key)}
              className={`px-3 py-1.5 text-xs border transition-colors ${
                filter === btn.key
                  ? "bg-brand-500 border-brand-500 text-white"
                  : "bg-white border-ink-900 text-ink-600 hover:text-ink-900"
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by review ID..."
          className={inputClass}
        />
      </div>

      {/* Log entries */}
      <div className="max-h-[500px] overflow-y-auto space-y-1.5">
        {filtered.length === 0 && (
          <p className="text-center text-ink-600 py-8">No log entries match the current filters.</p>
        )}
        {filtered.map((review) => {
          const level = getLogLevel(review);
          const truncatedId =
            review.id.length > 12 ? review.id.slice(0, 12) + "..." : review.id;
          return (
            <div
              key={review.id}
              className={`flex items-center gap-3 px-3 py-2.5 border text-sm ${LEVEL_BG[level]}`}
            >
              <span className="text-xs text-ink-600 font-mono shrink-0 w-36">
                {new Date(review.startedAt).toLocaleDateString()} {" "}
                {new Date(review.startedAt).toLocaleTimeString()}
              </span>
              <span className="font-mono text-xs text-ink-700 shrink-0 w-28" title={review.id}>
                {truncatedId}
              </span>
              <span
                className={`text-xs font-medium shrink-0 w-16 ${LEVEL_COLORS[level]}`}
              >
                {level.toUpperCase()}
              </span>
              <span
                className={`text-xs shrink-0 w-24 ${
                  review.phase === "complete"
                    ? "text-emerald-700"
                    : review.phase === "failed"
                    ? "text-rose-700"
                    : "text-brand-600"
                }`}
              >
                {review.phase}
              </span>
              <span className="text-xs text-ink-600 shrink-0">
                {review.totalFindings} finding{review.totalFindings !== 1 ? "s" : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
