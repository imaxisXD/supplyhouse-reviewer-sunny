import { useState } from "react";
import type { MastraSpan } from "../api/client";

const SPAN_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  agent_run: { bg: "bg-brand-500", text: "text-brand-700" },
  model_generation: { bg: "bg-emerald-500", text: "text-emerald-700" },
  tool_call: { bg: "bg-amber-500", text: "text-amber-700" },
  mcp_tool_call: { bg: "bg-violet-500", text: "text-violet-700" },
  workflow_run: { bg: "bg-sky-500", text: "text-sky-700" },
  default: { bg: "bg-ink-400", text: "text-ink-600" },
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
  if (!endTime) return "...";
  const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function getSpanType(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes("agent")) return "agent_run";
  if (lowerName.includes("model") || lowerName.includes("generate")) return "model_generation";
  if (lowerName.includes("mcp")) return "mcp_tool_call";
  if (lowerName.includes("tool")) return "tool_call";
  if (lowerName.includes("workflow")) return "workflow_run";
  return "default";
}

interface Props {
  spans: MastraSpan[];
  loading: boolean;
  onClose: () => void;
  agentName: string;
}

export default function InlineTracePanel({ spans, loading, onClose, agentName }: Props) {
  const [expandedSpan, setExpandedSpan] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="border border-ink-900 bg-warm-50 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-ink-700">Loading trace for {agentName}...</span>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-700 text-xs"
          >
            Close
          </button>
        </div>
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-ink-200 rounded w-3/4"></div>
          <div className="h-4 bg-ink-200 rounded w-1/2 ml-4"></div>
          <div className="h-4 bg-ink-200 rounded w-2/3 ml-4"></div>
        </div>
      </div>
    );
  }

  if (spans.length === 0) {
    return (
      <div className="border border-ink-900 bg-warm-50 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-ink-700">Trace: {agentName}</span>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-700 text-xs"
          >
            Close
          </button>
        </div>
        <p className="text-xs text-ink-600">No spans found for this trace.</p>
      </div>
    );
  }

  const spanTree = buildSpanTree(spans);
  const flatSpans = flattenTree(spanTree);

  // Calculate timeline bounds
  const timelineStart = Math.min(...spans.map((s) => new Date(s.startTime).getTime()));
  const timelineEnd = Math.max(
    ...spans.map((s) =>
      s.endTime ? new Date(s.endTime).getTime() : new Date(s.startTime).getTime()
    )
  );
  const timelineDuration = timelineEnd - timelineStart || 1;

  return (
    <div className="border border-ink-900 bg-warm-50 p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-ink-700">
          Trace: {agentName}
          <span className="ml-2 text-ink-500">({spans.length} spans)</span>
        </span>
        <button
          onClick={onClose}
          className="text-ink-500 hover:text-ink-700 text-xs px-2 py-0.5 border border-ink-300 hover:border-ink-500 transition"
        >
          Close
        </button>
      </div>

      <div className="space-y-1 max-h-64 overflow-y-auto">
        {flatSpans.map((span) => {
          const spanType = getSpanType(span.name);
          const colors = SPAN_TYPE_COLORS[spanType] || SPAN_TYPE_COLORS.default;
          const startOffset =
            ((new Date(span.startTime).getTime() - timelineStart) / timelineDuration) * 100;
          const spanWidth = span.endTime
            ? ((new Date(span.endTime).getTime() - new Date(span.startTime).getTime()) /
                timelineDuration) *
              100
            : 5;
          const isExpanded = expandedSpan === span.id;

          return (
            <div key={span.id}>
              <button
                onClick={() => setExpandedSpan(isExpanded ? null : span.id)}
                className="w-full text-left hover:bg-warm-100 transition rounded"
                style={{ paddingLeft: `${span.depth * 12 + 4}px` }}
              >
                <div className="flex items-center gap-2 py-1 pr-2">
                  {/* Tree connector */}
                  {span.depth > 0 && (
                    <span className="text-ink-400 text-[10px]">
                      {span.children.length > 0 ? "├─" : "└─"}
                    </span>
                  )}

                  {/* Span type badge */}
                  <span
                    className={`text-[9px] px-1 py-0.5 rounded ${colors.bg} text-white shrink-0 uppercase`}
                  >
                    {spanType.replace("_", " ").slice(0, 6)}
                  </span>

                  {/* Span name */}
                  <span className="text-xs text-ink-800 truncate flex-1 min-w-0">
                    {span.name}
                  </span>

                  {/* Duration */}
                  <span className="text-[10px] text-ink-500 font-mono shrink-0">
                    {formatDuration(span.startTime, span.endTime)}
                  </span>

                  {/* Expand indicator */}
                  <span className="text-ink-400 text-[10px] shrink-0">
                    {isExpanded ? "▼" : "▶"}
                  </span>
                </div>

                {/* Mini timeline bar */}
                <div className="h-1 bg-ink-200 rounded-full overflow-hidden mx-1 mb-1">
                  <div
                    className={`h-full ${colors.bg}`}
                    style={{
                      marginLeft: `${startOffset}%`,
                      width: `${Math.max(spanWidth, 2)}%`,
                    }}
                  />
                </div>
              </button>

              {/* Expanded details */}
              {isExpanded && (
                <div
                  className="bg-white border border-ink-200 rounded p-2 mx-1 mb-1 text-xs"
                  style={{ marginLeft: `${span.depth * 12 + 16}px` }}
                >
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-ink-500">Started:</span>
                      <span className="ml-1 text-ink-700 font-mono">
                        {new Date(span.startTime).toLocaleTimeString()}
                      </span>
                    </div>
                    {span.endTime && (
                      <div>
                        <span className="text-ink-500">Ended:</span>
                        <span className="ml-1 text-ink-700 font-mono">
                          {new Date(span.endTime).toLocaleTimeString()}
                        </span>
                      </div>
                    )}
                  </div>

                  {span.attributes && Object.keys(span.attributes).length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] text-ink-500 uppercase mb-1">Attributes</div>
                      <pre className="text-[10px] bg-warm-100 p-1.5 rounded overflow-x-auto max-h-20 overflow-y-auto">
                        {JSON.stringify(span.attributes, null, 2)}
                      </pre>
                    </div>
                  )}

                  {span.input !== undefined && (
                    <div className="mt-2">
                      <div className="text-[10px] text-ink-500 uppercase mb-1">Input</div>
                      <pre className="text-[10px] bg-warm-100 p-1.5 rounded overflow-x-auto max-h-20 overflow-y-auto">
                        {typeof span.input === "string"
                          ? span.input.slice(0, 500) + (span.input.length > 500 ? "..." : "")
                          : JSON.stringify(span.input, null, 2).slice(0, 500)}
                      </pre>
                    </div>
                  )}

                  {span.output !== undefined && (
                    <div className="mt-2">
                      <div className="text-[10px] text-ink-500 uppercase mb-1">Output</div>
                      <pre className="text-[10px] bg-warm-100 p-1.5 rounded overflow-x-auto max-h-20 overflow-y-auto">
                        {typeof span.output === "string"
                          ? span.output.slice(0, 500) + (span.output.length > 500 ? "..." : "")
                          : JSON.stringify(span.output, null, 2).slice(0, 500)}
                      </pre>
                    </div>
                  )}

                  {span.status && span.status.code !== 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] text-rose-600 uppercase mb-1">Error</div>
                      <pre className="text-[10px] bg-rose-50 text-rose-700 p-1.5 rounded">
                        {span.status.message || `Error code: ${span.status.code}`}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
