import { useMemo } from "react";
import type { GraphNode, GraphLink, GraphEdgeType } from "../api/client";
import { NODE_COLORS, EDGE_COLORS } from "./GraphLegend";
import type { GraphNodeLabel } from "../api/client";

type FGNode = GraphNode & { x?: number; y?: number; z?: number; __connections?: number };

interface ConnectionEntry {
  link: GraphLink & { source: string | FGNode; target: string | FGNode };
  direction: "outgoing" | "incoming";
  connectedNode: FGNode;
}

interface NodeDetailPanelProps {
  node: FGNode;
  connections: ConnectionEntry[];
  onClose: () => void;
  onNavigateToNode: (node: FGNode) => void;
}

const EDGE_TYPE_LABELS: Record<string, string> = {
  IMPORTS: "Imports",
  CALLS: "Calls",
  CONTAINS: "Contains",
  HAS_METHOD: "Methods",
  EXTENDS: "Extends",
  IMPLEMENTS: "Implements",
};

export default function NodeDetailPanel({
  node,
  connections,
  onClose,
  onNavigateToNode,
}: NodeDetailPanelProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionEntry[]>();
    for (const conn of connections) {
      const type = conn.link.type;
      const arr = map.get(type) ?? [];
      arr.push(conn);
      map.set(type, arr);
    }
    return map;
  }, [connections]);

  const nodeColor = NODE_COLORS[node.label as GraphNodeLabel] ?? "#6b7280";
  const lineRange =
    node.startLine != null
      ? `L${node.startLine}${node.endLine != null ? `\u2013${node.endLine}` : ""}`
      : null;

  return (
    <div
      className="absolute top-0 right-0 bottom-0 z-20 flex flex-col animate-slide-in-right"
      style={{ width: 340 }}
    >
      {/* Outer shell: hard left border, warm background */}
      <div className="flex-1 flex flex-col border-l-2 border-ink-900 bg-warm-50 overflow-hidden">

        {/* ── Header ── */}
        <div className="flex-shrink-0 bg-white border-b border-ink-900">
          {/* Colored accent bar */}
          <div className="h-1" style={{ backgroundColor: nodeColor }} />

          <div className="px-5 pt-4 pb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="w-2 h-2 flex-shrink-0"
                  style={{
                    backgroundColor: nodeColor,
                    boxShadow: `0 0 6px ${nodeColor}40`,
                  }}
                />
                <span className="text-[10px] uppercase tracking-[0.35em] font-semibold text-ink-600">
                  {node.label}
                </span>
              </div>
              <button
                onClick={onClose}
                className="text-[10px] uppercase tracking-[0.2em] text-ink-500 hover:text-ink-900 transition-colors"
              >
                Close
              </button>
            </div>

            <p
              className="text-[13px] font-semibold text-ink-950 font-mono leading-snug break-all"
              title={node.name}
            >
              {node.name}
            </p>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Metadata ── */}
          <div className="px-5 py-4 border-b border-ink-900/15 bg-white">
            <div className="text-[9px] uppercase tracking-[0.4em] font-semibold text-ink-500 mb-3">
              Properties
            </div>

            <div className="space-y-2">
              {node.path && (
                <div>
                  <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Path</div>
                  <p className="text-[11px] text-ink-700 font-mono truncate" title={node.path}>
                    {node.path}
                  </p>
                </div>
              )}

              {/* Compact row: line range, language */}
              {(lineRange || node.language) && (
                <div className="flex gap-4">
                  {lineRange && (
                    <div>
                      <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Lines</div>
                      <p className="text-[11px] text-ink-700 font-mono">{lineRange}</p>
                    </div>
                  )}
                  {node.language && (
                    <div>
                      <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Lang</div>
                      <p className="text-[11px] text-ink-700 font-mono">{node.language}</p>
                    </div>
                  )}
                </div>
              )}

              {node.params && (
                <div>
                  <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Params</div>
                  <p className="text-[11px] text-ink-700 font-mono break-all">({node.params})</p>
                </div>
              )}

              {node.returnType && (
                <div>
                  <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Returns</div>
                  <p className="text-[11px] text-ink-700 font-mono">{node.returnType}</p>
                </div>
              )}

              {node.extendsName && (
                <div>
                  <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Extends</div>
                  <p className="text-[11px] font-mono" style={{ color: EDGE_COLORS.EXTENDS }}>
                    {node.extendsName}
                  </p>
                </div>
              )}

              {node.propertyCount != null && (
                <div className="flex gap-4">
                  <div>
                    <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Props</div>
                    <p className="text-[11px] text-ink-700 font-mono tabular-nums">{node.propertyCount}</p>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-[0.25em] text-ink-400 mb-0.5">Methods</div>
                    <p className="text-[11px] text-ink-700 font-mono tabular-nums">{node.methodCount ?? 0}</p>
                  </div>
                </div>
              )}

              {/* Badges */}
              {(node.isExported || node.isAsync) && (
                <div className="flex gap-1.5 pt-1">
                  {node.isExported && (
                    <span className="text-[9px] uppercase tracking-[0.2em] font-semibold px-2 py-0.5 border border-emerald-700/30 text-emerald-700 bg-emerald-50">
                      exported
                    </span>
                  )}
                  {node.isAsync && (
                    <span className="text-[9px] uppercase tracking-[0.2em] font-semibold px-2 py-0.5 border border-sky-700/30 text-sky-700 bg-sky-50">
                      async
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Connections ── */}
          <div className="px-5 py-4">
            <div className="flex items-baseline justify-between mb-4">
              <div className="text-[9px] uppercase tracking-[0.4em] font-semibold text-ink-500">
                Connections
              </div>
              <span className="text-[11px] font-mono text-ink-400 tabular-nums">
                {connections.length}
              </span>
            </div>

            {connections.length === 0 && (
              <div className="py-6 text-center">
                <p className="text-[10px] text-ink-400 uppercase tracking-[0.2em]">No connections</p>
              </div>
            )}

            <div className="space-y-5">
              {Array.from(grouped.entries()).map(([type, entries]) => {
                const edgeColor = EDGE_COLORS[type as GraphEdgeType] ?? "#6b7280";
                return (
                  <div key={type}>
                    {/* Edge group header */}
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="w-3 h-0.5 flex-shrink-0"
                        style={{ backgroundColor: edgeColor }}
                      />
                      <span
                        className="text-[10px] uppercase tracking-[0.25em] font-semibold"
                        style={{ color: edgeColor }}
                      >
                        {EDGE_TYPE_LABELS[type] ?? type}
                      </span>
                      <span className="text-[10px] text-ink-400 font-mono tabular-nums">
                        {entries.length}
                      </span>
                    </div>

                    {/* Connection items */}
                    <div className="border-l border-ink-900/10 ml-1">
                      {entries.map((conn, i) => {
                        const connNode = conn.connectedNode;
                        const link = conn.link;
                        const connColor = NODE_COLORS[connNode.label as GraphNodeLabel] ?? "#6b7280";
                        const isOut = conn.direction === "outgoing";

                        return (
                          <button
                            key={`${type}-${connNode.id}-${i}`}
                            onClick={() => onNavigateToNode(connNode)}
                            className="group w-full text-left flex flex-col pl-3 pr-1 py-1.5 hover:bg-white/80 transition-all"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[10px] font-mono text-ink-400 flex-shrink-0 w-3 text-center">
                                {isOut ? "\u2192" : "\u2190"}
                              </span>
                              <span
                                className="w-1.5 h-1.5 flex-shrink-0"
                                style={{ backgroundColor: connColor }}
                              />
                              <span className="text-[11px] text-ink-700 font-mono truncate group-hover:text-ink-950 transition-colors">
                                {connNode.name}
                              </span>
                            </div>

                            {/* IMPORTS: symbol list */}
                            {type === "IMPORTS" && link.symbols && link.symbols.length > 0 && (
                              <div className="ml-[18px] mt-0.5">
                                <span className="text-[10px] font-mono" style={{ color: EDGE_COLORS.IMPORTS }}>
                                  {link.symbols.join(", ")}
                                </span>
                              </div>
                            )}

                            {/* CALLS: line + weight */}
                            {type === "CALLS" && (link.line != null || (link.weight != null && link.weight > 1)) && (
                              <div className="ml-[18px] mt-0.5 flex items-center gap-2">
                                {link.line != null && (
                                  <span className="text-[10px] font-mono text-ink-400">
                                    L{link.line}
                                  </span>
                                )}
                                {link.weight != null && link.weight > 1 && (
                                  <span className="text-[10px] font-mono text-ink-400">
                                    {"\u00d7"}{link.weight}
                                  </span>
                                )}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Footer: connection count ── */}
        <div className="flex-shrink-0 border-t border-ink-900 bg-white px-5 py-2.5 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-[0.3em] text-ink-500">
            {node.__connections ?? 0} total edges
          </span>
          <span
            className="w-1.5 h-1.5"
            style={{ backgroundColor: nodeColor }}
          />
        </div>
      </div>
    </div>
  );
}
