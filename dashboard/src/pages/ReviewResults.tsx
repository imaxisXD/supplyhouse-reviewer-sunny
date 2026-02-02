import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getReviewResult } from "../api/client";
import type { ReviewResult } from "../api/client";
import FindingsTable from "../components/FindingsTable";
import { advanceJourneyStep } from "../journey";

const panelClass =
  "border border-ink-900 bg-white p-4";
const panelTitleClass = "text-[10px] uppercase tracking-[0.35em] text-ink-600";
const statCardClass = "border border-ink-900 bg-white p-4";
const statLabelClass = "text-[10px] uppercase tracking-[0.3em] text-ink-600";
const statValueClass = "mt-2 text-xl font-semibold text-ink-950";
const tableHeaderClass = "px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-ink-600";
const tableRowClass = "border-b border-ink-900 hover:bg-warm-100/60 transition-colors";
const tableCellClass = "px-4 py-2.5 text-sm text-ink-700";
const ghostButtonClass =
  "inline-flex items-center justify-center gap-2 border border-ink-900 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-ink-700 transition hover:border-brand-500 hover:text-brand-600";

function buildCommentUrl(prUrl: string, commentId?: string): string {
  const match = prUrl.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
  if (!match) return "#";
  const base = `https://bitbucket.org/${match[1]}/${match[2]}/pull-requests/${match[3]}`;
  // Inline comments live on the diff tab; append /diff and anchor to the comment ID
  return commentId ? `${base}/diff#comment-${commentId}` : base;
}

function escapeCsvField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_COLORS: Record<string, string> = {
  success: "bg-emerald-500",
  failed: "bg-rose-500",
  skipped: "bg-warm-300",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  success: "text-emerald-700",
  failed: "text-rose-700",
  skipped: "text-ink-600",
};

export default function ReviewResults() {
  const { id } = useParams<{ id: string }>();
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    void advanceJourneyStep("results");
    getReviewResult(id)
      .then(setResult)
      .catch((err) => setError(err.message));
  }, [id]);

  const handleExportJSON = () => {
    if (!result) return;
    downloadFile(JSON.stringify(result, null, 2), `review-${id}.json`, "application/json");
  };

  const handleExportCSV = () => {
    if (!result) return;
    const headers = ["File", "Line", "Severity", "Category", "Title", "Description", "Suggestion", "Confidence", "CWE"];
    const rows = result.findings.map((f: any) => [
      f.file, f.line, f.severity, f.category, f.title,
      f.description || "",
      f.suggestion || "",
      f.confidence ?? "", f.cwe ?? "",
    ]);
    const csv = [
      headers.map(escapeCsvField).join(","),
      ...rows.map((r: any[]) => r.map(escapeCsvField).join(",")),
    ].join("\n");
    downloadFile(csv, `review-${id}-findings.csv`, "text/csv");
  };

  if (error) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="border border-rose-400/50 bg-rose-50 p-4 text-rose-700">
          {error}
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-center py-16 text-ink-600">Loading results...</div>
    );
  }

  const { summary } = result;

  const severityOrder = ["critical", "high", "medium", "low", "info"];

  const maxTraceDuration =
    result.traces && result.traces.length > 0
      ? Math.max(...result.traces.map((t) => t.durationMs))
      : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Review</div>
          <h1 className="mt-2 text-2xl font-semibold text-ink-950">Review Results</h1>
          <p className="mt-2 text-sm font-mono text-ink-600">{id}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExportJSON} className={ghostButtonClass}>
            Export JSON
          </button>
          <button onClick={handleExportCSV} className={ghostButtonClass}>
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className={statCardClass}>
          <p className={statLabelClass}>Total Findings</p>
          <p className={statValueClass}>{summary.totalFindings}</p>
        </div>
        {severityOrder.map((sev) => {
          const count = summary.bySeverity[sev] ?? 0;
          const colorMap: Record<string, string> = {
            critical: "text-rose-700",
            high: "text-orange-700",
            medium: "text-amber-700",
            low: "text-sky-700",
            info: "text-ink-600",
          };
          return (
            <div key={sev} className={statCardClass}>
              <p className={`${statLabelClass} capitalize`}>{sev}</p>
              <p className={`${statValueClass} ${colorMap[sev]}`}>{count}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className={statCardClass}>
          <p className={statLabelClass}>Files Analyzed</p>
          <p className={`${statValueClass} text-brand-600`}>{summary.filesAnalyzed}</p>
        </div>
        <div className={statCardClass}>
          <p className={statLabelClass}>Duration</p>
          <p className={`${statValueClass} text-amber-700`}>
            {(summary.durationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className={statCardClass}>
          <p className={statLabelClass}>Cost</p>
          <p className={`${statValueClass} text-emerald-700`}>
            ${summary.costUsd.toFixed(4)}
          </p>
        </div>
      </div>

      {result.synthesis && (result.synthesis.summaryComment || result.synthesis.recommendation) && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-ink-950">Synthesis</h2>
          {result.synthesis.recommendation && (
            <div className={panelClass}>
              <p className={panelTitleClass}>Recommendation</p>
              <p className="mt-3 text-sm text-ink-800 whitespace-pre-wrap">
                {result.synthesis.recommendation}
              </p>
            </div>
          )}
          {result.synthesis.summaryComment && (
            <div className={panelClass}>
              <p className={panelTitleClass}>Summary Comment</p>
              <p className="mt-3 text-sm text-ink-800 whitespace-pre-wrap">
                {result.synthesis.summaryComment}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-ink-950">Findings</h2>
        <FindingsTable findings={result.findings} />
      </div>

      {result.traces && result.traces.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-ink-950">Agent Traces</h2>

          <div className="overflow-hidden border border-ink-900 bg-white">
            <div className="grid grid-cols-[1fr_80px_80px_80px_80px] gap-2 px-4 py-3 border-b border-ink-900 text-xs text-ink-600">
              <span>Agent</span>
              <span className="text-right">Status</span>
              <span className="text-right">Duration</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
            </div>
            {result.traces.map((trace) => (
              <div
                key={trace.agent}
                className="grid grid-cols-[1fr_80px_80px_80px_80px] gap-2 px-4 py-2.5 border-b border-ink-900 text-sm hover:bg-warm-100/70 transition-colors"
              >
                <span className="text-ink-900 font-medium">{trace.agent}</span>
                <span className="text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${STATUS_TEXT_COLORS[trace.status] ?? "text-ink-600"}`}
                  >
                    <span
                      className={`h-1.5 w-1.5 ${STATUS_COLORS[trace.status] ?? "bg-warm-300"}`}
                    />
                    {trace.status}
                  </span>
                </span>
                <span className="text-right text-ink-700 font-mono text-xs">
                  {(trace.durationMs / 1000).toFixed(1)}s
                </span>
                <span className="text-right text-ink-600 font-mono text-xs">
                  {trace.inputTokens + trace.outputTokens}
                </span>
                <span className="text-right text-ink-600 font-mono text-xs">
                  ${trace.costUsd.toFixed(4)}
                </span>
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-medium text-ink-700 mb-3">Relative Duration</h3>
            <div className="space-y-2">
              {result.traces.map((trace) => {
                const widthPercent =
                  maxTraceDuration > 0 ? (trace.durationMs / maxTraceDuration) * 100 : 0;
                return (
                  <div key={`bar-${trace.agent}`} className="flex items-center gap-3">
                    <span className="text-xs text-ink-600 w-32 shrink-0 text-right truncate">
                      {trace.agent}
                    </span>
                    <div className="flex-1 h-5 bg-warm-200 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          trace.status === "success"
                            ? "bg-emerald-500"
                            : trace.status === "failed"
                            ? "bg-rose-500"
                            : "bg-warm-400"
                        }`}
                        style={{ width: `${widthPercent}%` }}
                      />
                    </div>
                    <span className="text-xs text-ink-600 font-mono w-16 shrink-0">
                      {(trace.durationMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {result.commentsPosted && result.commentsPosted.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-ink-950">
            Comments Posted ({result.commentsPosted.length})
          </h2>
          <div className="overflow-hidden border border-ink-900 bg-white">
            <div className="grid grid-cols-[1fr_80px_120px] gap-2 px-4 py-3 border-b border-ink-900 text-xs text-ink-600">
              <span>File</span>
              <span className="text-right">Line</span>
              <span className="text-right">Link</span>
            </div>
            {result.commentsPosted.map((comment, idx) => (
              <div
                key={`comment-${idx}`}
                className={`grid grid-cols-[1fr_80px_120px] gap-2 ${tableCellClass} ${tableRowClass}`}
              >
                <span className="text-ink-700 font-mono text-xs truncate">
                  {comment.file}
                </span>
                <span className="text-right text-ink-600 font-mono text-xs">
                  {comment.line}
                </span>
                <span className="text-right">
                  {result.prUrl ? (
                    <a
                      href={buildCommentUrl(result.prUrl, comment.commentId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-brand-600 hover:text-brand-700 transition-colors"
                    >
                      View in Bitbucket
                    </a>
                  ) : (
                    <span className="text-xs text-ink-600">#{comment.commentId}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
