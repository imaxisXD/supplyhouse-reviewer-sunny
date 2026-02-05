import { useEffect, useState } from "react";
import {
  getMastraTraces,
  getMastraSpans,
  getMastraTraceStats,
} from "../api/client";
import type {
  MastraTrace,
  MastraSpan,
  TraceStatsResponse,
} from "../api/client";

const SPAN_TYPE_COLORS: Record<string, string> = {
  agent_run: "bg-brand-500",
  model_generation: "bg-emerald-500",
  tool_call: "bg-amber-500",
  workflow_run: "bg-violet-500",
  default: "bg-ink-400",
};

const SPAN_TYPE_TEXT_COLORS: Record<string, string> = {
  agent_run: "text-brand-700",
  model_generation: "text-emerald-700",
  tool_call: "text-amber-700",
  workflow_run: "text-violet-700",
  default: "text-ink-600",
};

interface SpanTreeNode extends MastraSpan {
  children: SpanTreeNode[];
  depth: number;
}

function buildSpanTree(spans: MastraSpan[]): SpanTreeNode[] {
  const spanMap = new Map<string, SpanTreeNode>();
  const roots: SpanTreeNode[] = [];

  // Initialize all spans as tree nodes
  for (const span of spans) {
    spanMap.set(span.id, { ...span, children: [], depth: 0 });
  }

  // Build tree structure
  for (const span of spans) {
    const node = spanMap.get(span.id)!;
    if (span.parentSpanId) {
      const parent = spanMap.get(span.parentSpanId);
      if (parent) {
        node.depth = parent.depth + 1;
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  // Sort children by start time
  function sortChildren(node: SpanTreeNode) {
    node.children.sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
    node.children.forEach(sortChildren);
  }
  roots.forEach(sortChildren);

  return roots;
}

function flattenTree(nodes: SpanTreeNode[]): SpanTreeNode[] {
  const result: SpanTreeNode[] = [];
  function traverse(node: SpanTreeNode) {
    result.push(node);
    node.children.forEach(traverse);
  }
  nodes.forEach(traverse);
  return result;
}

function formatDuration(startTime: string, endTime?: string): string {
  if (!endTime) return "running...";
  const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function getSpanType(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes("agent")) return "agent_run";
  if (lowerName.includes("model") || lowerName.includes("generate")) return "model_generation";
  if (lowerName.includes("tool")) return "tool_call";
  if (lowerName.includes("workflow")) return "workflow_run";
  return "default";
}

export default function MastraTraceViewer() {
  const [traces, setTraces] = useState<MastraTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [spans, setSpans] = useState<MastraSpan[]>([]);
  const [selectedSpan, setSelectedSpan] = useState<MastraSpan | null>(null);
  const [stats, setStats] = useState<TraceStatsResponse | null>(null);
  const [loadingTraces, setLoadingTraces] = useState(true);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [error, setError] = useState("");

  // Load traces and stats on mount
  useEffect(() => {
    Promise.all([getMastraTraces({ limit: 50 }), getMastraTraceStats()])
      .then(([tracesRes, statsRes]) => {
        setTraces(tracesRes.traces);
        setStats(statsRes);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingTraces(false));
  }, []);

  const handleSelectTrace = async (traceId: string) => {
    setSelectedTraceId(traceId);
    setLoadingSpans(true);
    setSpans([]);
    setSelectedSpan(null);
    setError("");

    try {
      const result = await getMastraSpans(traceId);
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
                    SPAN_TYPE_COLORS[getSpanType(type)] ?? SPAN_TYPE_COLORS.default
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
        {/* Left panel - trace list */}
        <div className="w-72 shrink-0">
          <h3 className="text-sm font-medium text-ink-700 mb-3">Recent Traces</h3>
          {loadingTraces && (
            <p className="text-sm text-ink-600">Loading traces...</p>
          )}
          {!loadingTraces && traces.length === 0 && (
            <p className="text-sm text-ink-600">
              No traces found. Run an agent to generate traces.
            </p>
          )}
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {traces.map((trace) => (
              <button
                key={trace.id}
                onClick={() => handleSelectTrace(trace.id)}
                className={`w-full text-left px-3 py-2.5 text-sm transition-colors border ${
                  selectedTraceId === trace.id
                    ? "bg-brand-500/10 border-brand-500/40 text-brand-700"
                    : "bg-white border-ink-900 text-ink-700 hover:bg-warm-100"
                }`}
              >
                <div className="font-mono text-xs truncate">{trace.id}</div>
                {trace.name && (
                  <div className="text-sm text-ink-800 truncate mt-0.5">
                    {trace.name}
                  </div>
                )}
                <div className="text-xs text-ink-500 mt-0.5">
                  {new Date(trace.startTime).toLocaleDateString()}{" "}
                  {new Date(trace.startTime).toLocaleTimeString()}
                </div>
              </button>
            ))}
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

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-300/70 text-sm text-rose-700 mb-4">
              {error}
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
                              SPAN_TYPE_COLORS[spanType]
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
                          className={`absolute h-full ${SPAN_TYPE_COLORS[spanType]}`}
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
