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
  info: "text-blue-400",
  warning: "text-yellow-400",
  error: "text-red-400",
};

const LEVEL_BG: Record<string, string> = {
  info: "bg-blue-900/20 border-blue-800/50",
  warning: "bg-yellow-900/20 border-yellow-800/50",
  error: "bg-red-900/20 border-red-800/50",
};

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
    return <div className="text-center py-12 text-gray-500">Loading logs...</div>;
  }

  if (error) {
    return (
      <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-sm">
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
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                filter === btn.key
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:text-white"
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
          className="flex-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
        />
      </div>

      {/* Log entries */}
      <div className="max-h-[500px] overflow-y-auto space-y-1.5 rounded-lg">
        {filtered.length === 0 && (
          <p className="text-center text-gray-600 py-8">No log entries match the current filters.</p>
        )}
        {filtered.map((review) => {
          const level = getLogLevel(review);
          const truncatedId =
            review.id.length > 12 ? review.id.slice(0, 12) + "..." : review.id;
          return (
            <div
              key={review.id}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm ${LEVEL_BG[level]}`}
            >
              <span className="text-xs text-gray-500 font-mono shrink-0 w-36">
                {new Date(review.startedAt).toLocaleDateString()}{" "}
                {new Date(review.startedAt).toLocaleTimeString()}
              </span>
              <span className="font-mono text-xs text-gray-300 shrink-0 w-28" title={review.id}>
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
                    ? "text-green-400"
                    : review.phase === "failed"
                    ? "text-red-400"
                    : "text-blue-400"
                }`}
              >
                {review.phase}
              </span>
              <span className="text-xs text-gray-400 shrink-0">
                {review.totalFindings} finding{review.totalFindings !== 1 ? "s" : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
