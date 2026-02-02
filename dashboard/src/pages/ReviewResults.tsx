import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getReviewResult } from "../api/client";
import type { ReviewResult } from "../api/client";
import FindingsTable from "../components/FindingsTable";

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
  success: "bg-green-500",
  failed: "bg-red-500",
  skipped: "bg-gray-500",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  success: "text-green-400",
  failed: "text-red-400",
  skipped: "text-gray-400",
};

export default function ReviewResults() {
  const { id } = useParams<{ id: string }>();
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
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
      <div className="max-w-xl mx-auto">
        <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-center py-16 text-gray-500">Loading results...</div>
    );
  }

  const { summary } = result;

  const severityOrder = ["critical", "high", "medium", "low", "info"];

  const maxTraceDuration =
    result.traces && result.traces.length > 0
      ? Math.max(...result.traces.map((t) => t.durationMs))
      : 0;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Review Results</h1>
        <div className="flex gap-2">
          <button
            onClick={handleExportJSON}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300 transition-colors"
          >
            Export JSON
          </button>
          <button
            onClick={handleExportCSV}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300 transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>
      <p className="text-gray-500 text-sm mb-8 font-mono">{id}</p>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Findings</p>
          <p className="text-2xl font-bold text-white">{summary.totalFindings}</p>
        </div>
        {severityOrder.map((sev) => {
          const count = summary.bySeverity[sev] ?? 0;
          const colorMap: Record<string, string> = {
            critical: "text-red-400",
            high: "text-orange-400",
            medium: "text-yellow-400",
            low: "text-blue-400",
            info: "text-gray-400",
          };
          return (
            <div key={sev} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-xs text-gray-500 mb-1 capitalize">{sev}</p>
              <p className={`text-2xl font-bold ${colorMap[sev]}`}>{count}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Files Analyzed</p>
          <p className="text-2xl font-bold text-blue-400">{summary.filesAnalyzed}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Duration</p>
          <p className="text-2xl font-bold text-purple-400">
            {(summary.durationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Cost</p>
          <p className="text-2xl font-bold text-emerald-400">
            ${summary.costUsd.toFixed(4)}
          </p>
        </div>
      </div>

      {result.synthesis && (result.synthesis.summaryComment || result.synthesis.recommendation) && (
        <div className="mb-10 space-y-4">
          <h2 className="text-lg font-semibold">Synthesis</h2>
          {result.synthesis.recommendation && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-xs text-gray-500 mb-2">Recommendation</p>
              <p className="text-sm text-gray-200 whitespace-pre-wrap">
                {result.synthesis.recommendation}
              </p>
            </div>
          )}
          {result.synthesis.summaryComment && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-xs text-gray-500 mb-2">Summary Comment</p>
              <p className="text-sm text-gray-200 whitespace-pre-wrap">
                {result.synthesis.summaryComment}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Findings Table */}
      <h2 className="text-lg font-semibold mb-4">Findings</h2>
      <FindingsTable findings={result.findings} />

      {/* Agent Traces */}
      {result.traces && result.traces.length > 0 && (
        <div className="mt-12">
          <h2 className="text-lg font-semibold mb-4">Agent Traces</h2>

          {/* Traces table */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-6">
            <div className="grid grid-cols-[1fr_80px_80px_80px_80px] gap-2 px-4 py-2 border-b border-gray-800 text-xs text-gray-500">
              <span>Agent</span>
              <span className="text-right">Status</span>
              <span className="text-right">Duration</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
            </div>
            {result.traces.map((trace) => (
              <div
                key={trace.agent}
                className="grid grid-cols-[1fr_80px_80px_80px_80px] gap-2 px-4 py-2.5 border-b border-gray-800/50 text-sm hover:bg-gray-800/30 transition-colors"
              >
                <span className="text-gray-200 font-medium">{trace.agent}</span>
                <span className="text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${STATUS_TEXT_COLORS[trace.status] ?? "text-gray-400"}`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[trace.status] ?? "bg-gray-500"}`}
                    />
                    {trace.status}
                  </span>
                </span>
                <span className="text-right text-gray-300 font-mono text-xs">
                  {(trace.durationMs / 1000).toFixed(1)}s
                </span>
                <span className="text-right text-gray-400 font-mono text-xs">
                  {trace.inputTokens + trace.outputTokens}
                </span>
                <span className="text-right text-gray-400 font-mono text-xs">
                  ${trace.costUsd.toFixed(4)}
                </span>
              </div>
            ))}
          </div>

          {/* Duration bar chart */}
          <h3 className="text-sm font-medium text-gray-400 mb-3">Relative Duration</h3>
          <div className="space-y-2">
            {result.traces.map((trace) => {
              const widthPercent =
                maxTraceDuration > 0 ? (trace.durationMs / maxTraceDuration) * 100 : 0;
              return (
                <div key={`bar-${trace.agent}`} className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 w-32 shrink-0 text-right truncate">
                    {trace.agent}
                  </span>
                  <div className="flex-1 h-5 bg-gray-800 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all duration-500 ${
                        trace.status === "success"
                          ? "bg-green-600"
                          : trace.status === "failed"
                          ? "bg-red-600"
                          : "bg-gray-600"
                      }`}
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 font-mono w-16 shrink-0">
                    {(trace.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Comments Posted */}
      {result.commentsPosted && result.commentsPosted.length > 0 && (
        <div className="mt-12">
          <h2 className="text-lg font-semibold mb-4">
            Comments Posted ({result.commentsPosted.length})
          </h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_80px_120px] gap-2 px-4 py-2 border-b border-gray-800 text-xs text-gray-500">
              <span>File</span>
              <span className="text-right">Line</span>
              <span className="text-right">Link</span>
            </div>
            {result.commentsPosted.map((comment, idx) => (
              <div
                key={`comment-${idx}`}
                className="grid grid-cols-[1fr_80px_120px] gap-2 px-4 py-2.5 border-b border-gray-800/50 text-sm hover:bg-gray-800/30 transition-colors"
              >
                <span className="text-gray-300 font-mono text-xs truncate">
                  {comment.file}
                </span>
                <span className="text-right text-gray-400 font-mono text-xs">
                  {comment.line}
                </span>
                <span className="text-right">
                  {result.prUrl ? (
                    <a
                      href={buildCommentUrl(result.prUrl, comment.commentId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      View in Bitbucket
                    </a>
                  ) : (
                    <span className="text-xs text-gray-600">#{comment.commentId}</span>
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
