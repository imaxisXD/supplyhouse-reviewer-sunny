import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getReviewsList, submitReview } from "../api/client";
import type { ReviewListItem } from "../api/client";

export default function Home() {
  const navigate = useNavigate();
  const [prUrl, setPrUrl] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [skipSecurity, setSkipSecurity] = useState(false);
  const [skipDuplication, setSkipDuplication] = useState(false);
  const [priorityFiles, setPriorityFiles] = useState("");
  const [recent, setRecent] = useState<ReviewListItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  const prUrlPattern = /^https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+/;

  useEffect(() => {
    setRecentLoading(true);
    getReviewsList(10)
      .then((res) => setRecent(res.reviews))
      .catch(() => setRecent([]))
      .finally(() => setRecentLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!prUrlPattern.test(prUrl)) {
      setError("Please enter a valid BitBucket PR URL");
      return;
    }
    if (!token.trim()) {
      setError("BitBucket token is required");
      return;
    }

    setLoading(true);
    try {
      const { reviewId } = await submitReview({
        prUrl,
        token,
        options: {
          skipSecurity,
          skipDuplication,
          priorityFiles: priorityFiles
            ? priorityFiles.split(",").map((f) => f.trim()).filter(Boolean)
            : undefined,
        },
      });
      navigate(`/review/${reviewId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Submit PR Review</h1>
      <p className="text-gray-400 mb-8">
        Paste a BitBucket pull request URL to start an AI-powered code review.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">PR URL</label>
          <input
            type="url"
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1.5">BitBucket Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Your BitBucket access token"
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
          />
        </div>

        {/* Review Options */}
        <div className="border border-gray-700 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowOptions(!showOptions)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-900 text-sm text-gray-300 hover:bg-gray-800 transition-colors"
          >
            <span>Review Options</span>
            <span className="text-gray-500">{showOptions ? "−" : "+"}</span>
          </button>
          {showOptions && (
            <div className="px-4 py-4 bg-gray-900/50 space-y-4 border-t border-gray-700">
              <label className="flex items-center gap-3 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipSecurity}
                  onChange={(e) => setSkipSecurity(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/20"
                />
                Skip security analysis
              </label>
              <label className="flex items-center gap-3 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipDuplication}
                  onChange={(e) => setSkipDuplication(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/20"
                />
                Skip duplication analysis
              </label>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">
                  Priority Files (comma-separated)
                </label>
                <input
                  type="text"
                  value={priorityFiles}
                  onChange={(e) => setPriorityFiles(e.target.value)}
                  placeholder="src/api/auth.ts, src/db/queries.ts"
                  className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
                />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? "Submitting..." : "Start Review"}
        </button>
      </form>

      <div className="mt-12">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Recent Reviews</h2>
          <span className="text-xs text-gray-500">Last 10</span>
        </div>
        {recentLoading && (
          <div className="text-sm text-gray-500">Loading recent reviews...</div>
        )}
        {!recentLoading && recent.length === 0 && (
          <div className="text-sm text-gray-600">No completed reviews yet.</div>
        )}
        {recent.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_100px_100px_100px] gap-2 px-4 py-2 border-b border-gray-800 text-xs text-gray-500">
              <span>Review</span>
              <span className="text-right">Findings</span>
              <span className="text-right">Duration</span>
              <span className="text-right">Cost</span>
            </div>
            {recent.map((review) => (
              <Link
                key={review.id}
                to={`/review/${review.id}/results`}
                className="grid grid-cols-[1fr_100px_100px_100px] gap-2 px-4 py-2.5 border-b border-gray-800/50 text-sm hover:bg-gray-800/30 transition-colors"
              >
                <span className="text-gray-200 font-mono text-xs truncate">
                  {review.id}
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
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
