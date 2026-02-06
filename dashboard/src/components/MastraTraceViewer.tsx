import { useState } from "react";
import { getMastraSpans } from "../api/client";
import { useMastraTraceStats, useTracesByReview } from "../api/hooks";
import { IconChevronRightOutline24 } from "nucleo-core-essential-outline-24";
import type {
  MastraSpan,
  ReviewTraceGroup,
  ReviewTraceAgent,
} from "../api/types";
import { buildSpanTree, flattenTree, getSpanType, SPAN_TYPE_COLORS } from "../utils/span-tree";
import { formatDurationSpan as formatDuration } from "../utils/format";

const STATUS_DOT: Record<string, string> = {
  success: "bg-emerald-500",
  error: "bg-rose-500",
  running: "bg-amber-500",
};

function shortPrLabel(prUrl: string | null, reviewId: string): string {
  if (prUrl) {
    const match = prUrl.match(/\/pull-requests\/(\d+)/);
    if (match) return `PR #${match[1]}`;
  }
  return reviewId.slice(0, 8) + "\u2026";
}

function shortAgentName(name: string): string {
  const match = name.match(/agent run: '(.+?)'/);
  return match ? match[1] : name;
}

export default function MastraTraceViewer() {
  const { data: stats, error: statsError, isLoading: statsLoading } = useMastraTraceStats();
  const { data: groupsData, error: groupsError, isLoading: groupsLoading } = useTracesByReview();
  const reviewGroups: ReviewTraceGroup[] = groupsData?.reviews ?? [];
  const loadingTraces = statsLoading || groupsLoading;
  const swrError = statsError || groupsError;

  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [spans, setSpans] = useState<MastraSpan[]>([]);
  const [selectedSpan, setSelectedSpan] = useState<MastraSpan | null>(null);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [error, setError] = useState("");

  const handleToggleReview = (reviewId: string) => {
    setExpandedReview((prev) => (prev === reviewId ? null : reviewId));
  };

  const handleSelectAgent = async (agent: ReviewTraceAgent) => {
    setSelectedTraceId(agent.traceId);
    setLoadingSpans(true);
    setSpans([]);
    setSelectedSpan(null);
    setError("");

    try {
      const result = await getMastraSpans(agent.traceId);
      setSpans(result.spans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load spans");
    } finally {
      setLoadingSpans(false);
    }
  };

  const spanTree = buildSpanTree(spans);
  const flatSpans = flattenTree(spanTree);

  // Calculate timeline bounds
  const timelineStart = spans.length > 0
    ? Math.min(...spans.map((s) => new Date(s.startTime).getTime()))
    : 0;
  const timelineEnd = spans.length > 0
    ? Math.max(
        ...spans.map((s) =>
          s.endTime ? new Date(s.endTime).getTime() : new Date(s.startTime).getTime()
        )
      )
    : 0;
  const timelineDuration = timelineEnd - timelineStart || 1;

  return (
    <div className="space-y-6">
      {/* Stats Header */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white border border-ink-900 p-4">
            <div className="text-2xl font-semibold text-ink-900">
              {stats.totalTraces}
            </div>
            <div className="text-sm text-ink-600">Total Traces</div>
          </div>
          <div className="bg-white border border-ink-900 p-4">
            <div className="text-2xl font-semibold text-ink-900">
              {stats.totalSpans}
            </div>
            <div className="text-sm text-ink-600">Total Spans</div>
          </div>
          <div className="bg-white border border-ink-900 p-4">
            <div className="text-2xl font-semibold text-ink-900">
              {stats.avgDurationMs ? `${(stats.avgDurationMs / 1000).toFixed(2)}s` : "-"}
            </div>
            <div className="text-sm text-ink-600">Avg Duration</div>
          </div>
          <div className="bg-white border border-ink-900 p-4">
            <div className="flex flex-wrap gap-1">
              {Object.entries(stats.spanTypeCount).slice(0, 4).map(([type, count]) => (
                <span
                  key={type}
                  className={`text-xs px-2 py-0.5 rounded ${
                    (SPAN_TYPE_COLORS[getSpanType(type)] ?? SPAN_TYPE_COLORS.default).bg
                  } text-white`}
                >
                  {type}: {count}
                </span>
              ))}
            </div>
            <div className="text-sm text-ink-600 mt-1">Span Types</div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex gap-6 min-h-[500px]">
        {/* Left panel - review-grouped trace list */}
        <div className="w-72 shrink-0">
          <h3 className="text-sm font-medium text-ink-700 mb-3">Recent Traces</h3>
          {loadingTraces && (
            <p className="text-sm text-ink-600">Loading traces...</p>
          )}
          {!loadingTraces && reviewGroups.length === 0 && (
            <p className="text-sm text-ink-600">
              No traces found. Run an agent to generate traces.
            </p>
          )}
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {reviewGroups.map((group) => {
              const isExpanded = expandedReview === group.reviewId;
              const isUnlinked = group.reviewId === "unlinked";
              return (
                <div key={group.reviewId}>
                  {/* Review header row */}
                  <button
                    onClick={() => handleToggleReview(group.reviewId)}
                    className={`w-full text-left px-3 py-2.5 text-sm transition-colors border ${
                      isExpanded
                        ? "bg-brand-500/10 border-brand-500/40"
                        : "bg-white border-ink-900 hover:bg-warm-100"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`transition-transform text-ink-500 ${isExpanded ? "rotate-90" : ""}`}>
                          <IconChevronRightOutline24 size={12} />
                        </span>
                        <span className="font-mono text-xs text-ink-800 truncate">
                          {isUnlinked ? "Unlinked traces" : shortPrLabel(group.prUrl, group.reviewId)}
                        </span>
                      </div>
                      <span className="text-xs text-ink-500 shrink-0 ml-2">
                        {group.agentCount} agents
                      </span>
                    </div>
                    {group.startTime && (
                      <div className="text-xs text-ink-500 mt-1 pl-5">
                        {new Date(group.startTime).toLocaleDateString()}{" "}
                        {new Date(group.startTime).toLocaleTimeString()}
                        {group.startTime && group.endTime && (
                          <span className="ml-2 text-ink-400">
                            ({formatDuration(group.startTime, group.endTime)})
                          </span>
                        )}
                      </div>
                    )}
                  </button>

                  {/* Expanded agent list */}
                  {isExpanded && (
                    <div className="ml-4 space-y-0.5 mt-0.5">
                      {group.agents.map((agent) => (
                        <button
                          key={agent.traceId}
                          onClick={() => handleSelectAgent(agent)}
                          className={`w-full text-left px-3 py-2 text-xs transition-colors border ${
                            selectedTraceId === agent.traceId
                              ? "bg-brand-500/10 border-brand-500/40 text-brand-700"
                              : "bg-warm-50 border-ink-900 text-ink-700 hover:bg-warm-100"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[agent.status] ?? STATUS_DOT.running}`} />
                              <span className="truncate">{shortAgentName(agent.name)}</span>
                            </div>
                            <span className="text-ink-500 shrink-0 ml-2">
                              {agent.startTime && formatDuration(agent.startTime, agent.endTime)}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Middle panel - span timeline */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-ink-700 mb-3">Span Timeline</h3>

          {!selectedTraceId && (
            <div className="flex items-center justify-center h-64 text-ink-600 text-sm">
              Select a trace from the left panel to view its spans.
            </div>
          )}

          {selectedTraceId && loadingSpans && (
            <div className="flex items-center justify-center h-64 text-ink-600 text-sm">
              Loading spans...
            </div>
          )}

          {(error || swrError) && (
            <div className="p-3 bg-rose-50 border border-rose-300/70 text-sm text-rose-700 mb-4">
              {error || (swrError instanceof Error ? swrError.message : "Failed to load traces")}
            </div>
          )}

          {selectedTraceId && !loadingSpans && spans.length === 0 && !error && (
            <div className="flex items-center justify-center h-64 text-ink-600 text-sm">
              No spans available for this trace.
            </div>
          )}

          {flatSpans.length > 0 && (
            <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-2">
              {flatSpans.map((span) => {
                const spanType = getSpanType(span.name);
                const startOffset =
                  ((new Date(span.startTime).getTime() - timelineStart) /
                    timelineDuration) *
                  100;
                const spanWidth = span.endTime
                  ? ((new Date(span.endTime).getTime() -
                      new Date(span.startTime).getTime()) /
                      timelineDuration) *
                    100
                  : 5;

                return (
                  <button
                    key={span.id}
                    onClick={() => setSelectedSpan(span)}
                    className={`w-full text-left transition-colors border ${
                      selectedSpan?.id === span.id
                        ? "bg-brand-500/10 border-brand-500/40"
                        : "bg-white border-ink-900 hover:bg-warm-50"
                    }`}
                    style={{ paddingLeft: `${span.depth * 16 + 12}px` }}
                  >
                    <div className="py-2 pr-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded ${
                              (SPAN_TYPE_COLORS[spanType] ?? SPAN_TYPE_COLORS.default).bg
                            } text-white shrink-0`}
                          >
                            {spanType.replace("_", " ")}
                          </span>
                          <span className="text-sm font-medium text-ink-900 truncate">
                            {span.name}
                          </span>
                        </div>
                        <span className="text-xs text-ink-600 shrink-0 ml-2">
                          {formatDuration(span.startTime, span.endTime)}
                        </span>
                      </div>
                      {/* Timeline bar */}
                      <div className="w-full h-3 bg-warm-200 overflow-hidden relative">
                        <div
                          className={`absolute h-full ${(SPAN_TYPE_COLORS[spanType] ?? SPAN_TYPE_COLORS.default).bg}`}
                          style={{
                            left: `${startOffset}%`,
                            width: `${Math.max(spanWidth, 1)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right panel - span details */}
        <div className="w-80 shrink-0">
          <h3 className="text-sm font-medium text-ink-700 mb-3">Span Details</h3>

          {!selectedSpan && (
            <div className="flex items-center justify-center h-64 text-ink-600 text-sm bg-white border border-ink-900 p-4">
              Click a span to view its details.
            </div>
          )}

          {selectedSpan && (
            <div className="bg-white border border-ink-900 p-4 space-y-4 max-h-[500px] overflow-y-auto">
              <div>
                <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                  Name
                </div>
                <div className="text-sm font-medium text-ink-900">
                  {selectedSpan.name}
                </div>
              </div>

              <div>
                <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                  Duration
                </div>
                <div className="text-sm text-ink-800">
                  {formatDuration(selectedSpan.startTime, selectedSpan.endTime)}
                </div>
              </div>

              <div>
                <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                  Time
                </div>
                <div className="text-sm text-ink-800">
                  {new Date(selectedSpan.startTime).toLocaleString()}
                </div>
              </div>

              {selectedSpan.scope && (
                <div>
                  <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                    Scope
                  </div>
                  <div className="text-sm text-ink-800 font-mono">
                    {selectedSpan.scope}
                  </div>
                </div>
              )}

              {selectedSpan.status && (
                <div>
                  <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                    Status
                  </div>
                  <div
                    className={`text-sm ${
                      selectedSpan.status.code === 0
                        ? "text-emerald-700"
                        : selectedSpan.status.code === 2
                        ? "text-rose-700"
                        : "text-ink-800"
                    }`}
                  >
                    {selectedSpan.status.code === 0
                      ? "OK"
                      : selectedSpan.status.code === 2
                      ? "Error"
                      : `Code: ${selectedSpan.status.code}`}
                    {selectedSpan.status.message && (
                      <span className="ml-2 text-ink-600">
                        - {selectedSpan.status.message}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {selectedSpan.attributes &&
                Object.keys(selectedSpan.attributes).length > 0 && (
                  <div>
                    <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                      Attributes
                    </div>
                    <pre className="text-xs bg-warm-100 p-2 overflow-x-auto max-h-32 overflow-y-auto">
                      {JSON.stringify(selectedSpan.attributes, null, 2)}
                    </pre>
                  </div>
                )}

              {selectedSpan.input !== undefined && (
                <div>
                  <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                    Input
                  </div>
                  <pre className="text-xs bg-warm-100 p-2 overflow-x-auto max-h-40 overflow-y-auto">
                    {typeof selectedSpan.input === "string"
                      ? selectedSpan.input
                      : JSON.stringify(selectedSpan.input, null, 2)}
                  </pre>
                </div>
              )}

              {selectedSpan.output !== undefined && (
                <div>
                  <div className="text-xs text-ink-500 uppercase tracking-wider mb-1">
                    Output
                  </div>
                  <pre className="text-xs bg-warm-100 p-2 overflow-x-auto max-h-40 overflow-y-auto">
                    {typeof selectedSpan.output === "string"
                      ? selectedSpan.output
                      : JSON.stringify(selectedSpan.output, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
