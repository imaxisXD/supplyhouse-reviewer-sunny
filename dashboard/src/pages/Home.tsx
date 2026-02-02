import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getReviewsList, submitReview } from "../api/client";
import type { ReviewListItem } from "../api/client";
import { useJourney, journeySteps, getJourneyStatus } from "../journey";

const panelClass =
  "border border-ink-900 bg-white p-4";
const panelSoftClass = "border border-dashed border-ink-900 bg-warm-50 p-4";
const panelTitleClass = "text-[10px] uppercase tracking-[0.35em] text-ink-600";
const labelClass = "text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-600";
const inputClass =
  "w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500";
const buttonPrimaryClass =
  "inline-flex items-center justify-center gap-2 border border-brand-500 bg-brand-500 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60";
const badgeBrandClass =
  "inline-flex items-center gap-1 border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-700";
const tableHeaderClass = "px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-ink-600";
const tableRowClass = "border-t border-ink-900 hover:bg-warm-100/60 transition";
const tableCellClass = "px-4 py-3 text-ink-700";

export default function Home() {
  const navigate = useNavigate();
  const { currentStep, advanceStep, loading: journeyLoading } = useJourney();
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
      .then((res) => {
        setRecent(res.reviews);
        if (res.reviews.length > 0) {
          advanceStep("results");
        }
      })
      .catch(() => setRecent([]))
      .finally(() => setRecentLoading(false));
  }, [advanceStep]);

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
      advanceStep("review");
      navigate(`/review/${reviewId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setLoading(false);
    }
  };

  const isFirstRun = !journeyLoading && !recentLoading && recent.length === 0 && currentStep === "submit";

  const activeStep = journeySteps.find((step) => step.id === currentStep);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Code Review Agent</div>
          <h1 className="mt-2 text-2xl font-semibold text-ink-950">AI Code Review Agent</h1>
          <p className="mt-2 text-sm text-ink-700">
            Paste a Bitbucket pull request URL to start an AI-powered code review.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 border border-ink-900 bg-white px-3 py-2 text-xs text-ink-700">
            <span className="h-2 w-2 bg-brand-500" />
            Bitbucket
          </div>
        </div>
      </div>

      <div className={panelClass}>
        <div className="flex flex-wrap items-center gap-4">
          {journeySteps.map((step) => {
            const status = getJourneyStatus(currentStep, step.id);
            const bar =
              status === "complete"
                ? "bg-brand-500"
                : status === "current"
                ? "bg-brand-500/70"
                : "bg-warm-200";
            const label =
              status === "current"
                ? "text-brand-600"
                : status === "complete"
                ? "text-emerald-600"
                : "text-ink-600";
            return (
              <div key={step.id} className="flex-1 min-w-[140px]">
                <div className={`h-1 ${bar}`} />
                <div className={`mt-2 text-[10px] uppercase tracking-[0.35em] ${label}`}>
                  {step.sidebarLabel}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-600">
          <span>{activeStep?.description}</span>
          {activeStep?.hint && (
            <span className="text-brand-600">{activeStep.hint}</span>
          )}
        </div>
      </div>

      {isFirstRun && (
        <section className={panelSoftClass}>
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div>
              <span className={badgeBrandClass}>Empty dashboard</span>
              <h2 className="mt-3 text-lg font-semibold text-ink-950">Go, complete step one</h2>
              <p className="mt-2 text-sm text-ink-700">
                Your dashboard is empty until the first review finishes. Start with the PR URL and token below.
              </p>
            </div>
            <a href="#new-review" className={buttonPrimaryClass}>
              Start review
            </a>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] gap-6">
        <div className={panelClass} id="new-review">
          <div className="flex items-center justify-between">
            <div className={panelTitleClass}>Review setup</div>
            {isFirstRun && <span className={badgeBrandClass}>Step 1</span>}
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-5">
            <div>
              <label htmlFor="pr-url" className={labelClass}>PR URL</label>
              <input
                id="pr-url"
                type="url"
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
                className={`${inputClass} mt-2`}
                autoComplete="url"
              />
            </div>

            <div>
              <label htmlFor="token" className={labelClass}>Bitbucket Token</label>
              <input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Your Bitbucket access token…"
                className={`${inputClass} mt-2`}
                autoComplete="current-password"
              />
            </div>

            <div className="border border-ink-900 bg-warm-50">
              <button
                type="button"
                onClick={() => setShowOptions(!showOptions)}
                className="flex w-full items-center justify-between px-4 py-3 text-[10px] uppercase tracking-[0.35em] text-ink-600 hover:text-ink-900 transition"
              >
                Review options
                <span>{showOptions ? "−" : "+"}</span>
              </button>
              {showOptions && (
                <div className="border-t border-ink-900 px-4 py-4 space-y-4">
                  <label className="flex items-center gap-3 text-xs text-ink-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipSecurity}
                      onChange={(e) => setSkipSecurity(e.target.checked)}
                      className="h-4 w-4 border-ink-900 bg-white accent-brand-500"
                    />
                    Skip security analysis
                  </label>
                  <label className="flex items-center gap-3 text-xs text-ink-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipDuplication}
                      onChange={(e) => setSkipDuplication(e.target.checked)}
                      className="h-4 w-4 border-ink-900 bg-white accent-brand-500"
                    />
                    Skip duplication analysis
                  </label>
                  <div>
                    <label htmlFor="priority-files" className={labelClass}>Priority Files</label>
                    <input
                      id="priority-files"
                      type="text"
                      value={priorityFiles}
                      onChange={(e) => setPriorityFiles(e.target.value)}
                      placeholder="src/api/auth.ts, src/db/queries.ts…"
                      className={`${inputClass} mt-2`}
                    />
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className={`${buttonPrimaryClass} w-full`}>
              {loading ? "Submitting…" : "Start Review"}
            </button>
          </form>
        </div>

        <div className={panelClass}>
          <div className="flex items-center justify-between">
            <div className={panelTitleClass}>Recent Reviews</div>
            <span className="text-[10px] uppercase tracking-[0.35em] text-ink-600">Last 10</span>
          </div>

          {recentLoading && <div className="mt-4 text-xs text-ink-600">Loading…</div>}

          {!recentLoading && recent.length === 0 && (
            <div className="mt-6 border border-dashed border-ink-900 bg-warm-50 p-6 text-sm text-ink-700">
              <div className="text-[10px] uppercase tracking-[0.3em] text-ink-600">Empty state</div>
              <p className="mt-2">
                No completed reviews yet. Step 3 will appear here when your first review finishes.
              </p>
            </div>
          )}

          {recent.length > 0 && (
            <div className="mt-4 overflow-hidden border border-ink-900">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className={tableHeaderClass}>Review</th>
                    <th className={`${tableHeaderClass} text-right`}>Findings</th>
                    <th className={`${tableHeaderClass} text-right`}>Duration</th>
                    <th className={`${tableHeaderClass} text-right`}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((review) => (
                    <tr key={review.id} className={tableRowClass}>
                      <td className={tableCellClass}>
                        <Link
                          to={`/review/${review.id}/results`}
                          className="font-mono text-[11px] text-brand-600 hover:underline"
                        >
                          {review.id.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{review.totalFindings}</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{(review.durationMs / 1000).toFixed(1)}s</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>${review.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
