import type { GraphNodeLabel, GraphEdgeType } from "../api/client";

export const NODE_COLORS: Record<GraphNodeLabel, string> = {
  File: "#f36a28",
  Function: "#2f80ed",
  Class: "#f2b35d",
};

export const EDGE_COLORS: Record<GraphEdgeType, string> = {
  CONTAINS: "#bfb4a5",
  CALLS: "#f36a28",
  IMPORTS: "#2f80ed",
  HAS_METHOD: "#f2b35d",
  EXTENDS: "#d9574c",
  IMPLEMENTS: "#d9b25c",
};

export const NODE_SIZES: Record<GraphNodeLabel, number> = {
  File: 6,
  Function: 3,
  Class: 5,
};

interface GraphLegendProps {
  nodeFilters: Record<GraphNodeLabel, boolean>;
  edgeFilters: Record<GraphEdgeType, boolean>;
  onToggleNode: (label: GraphNodeLabel) => void;
  onToggleEdge: (type: GraphEdgeType) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  stats: {
    totalNodes: number;
    totalLinks: number;
    byNodeType: Record<string, number>;
    byEdgeType: Record<string, number>;
  };
}

export default function GraphLegend({
  nodeFilters,
  edgeFilters,
  onToggleNode,
  onToggleEdge,
  searchQuery,
  onSearchChange,
  stats,
}: GraphLegendProps) {
  return (
    <div className="absolute top-4 left-4 z-10 w-64 bg-white border border-ink-900 overflow-hidden">
      {/* Search */}
      <div className="p-3 border-b border-ink-900">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search nodes..."
          className="w-full px-3 py-1.5 bg-white border border-ink-900 text-xs text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500"
        />
      </div>

      {/* Stats */}
      <div className="px-3 py-2 border-b border-ink-900 flex gap-4 text-xs text-ink-600">
        <span>{stats.totalNodes} nodes</span>
        <span>{stats.totalLinks} edges</span>
      </div>

      {/* Node types */}
      <div className="p-3 border-b border-ink-900">
        <p className="text-[10px] uppercase tracking-wider text-ink-600 mb-2">Node Types</p>
        <div className="space-y-1.5">
          {(Object.keys(NODE_COLORS) as GraphNodeLabel[]).map((label) => (
            <label
              key={label}
              className="flex items-center gap-2 text-xs text-ink-700 cursor-pointer hover:text-ink-900 transition-colors"
            >
              <input
                type="checkbox"
                checked={nodeFilters[label]}
                onChange={() => onToggleNode(label)}
                className="border-ink-900 bg-white text-brand-500 h-3 w-3 accent-brand-500"
              />
              <span
                className="w-2.5 h-2.5 flex-shrink-0"
                style={{ backgroundColor: NODE_COLORS[label] }}
              />
              <span className="flex-1">{label}</span>
              <span className="text-ink-500">{stats.byNodeType[label] ?? 0}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Edge types */}
      <div className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-ink-600 mb-2">Edge Types</p>
        <div className="space-y-1.5">
          {(Object.keys(EDGE_COLORS) as GraphEdgeType[]).map((type) => (
            <label
              key={type}
              className="flex items-center gap-2 text-xs text-ink-700 cursor-pointer hover:text-ink-900 transition-colors"
            >
              <input
                type="checkbox"
                checked={edgeFilters[type]}
                onChange={() => onToggleEdge(type)}
                className="border-ink-900 bg-white text-brand-500 h-3 w-3 accent-brand-500"
              />
              <span
                className="w-4 h-0.5 flex-shrink-0"
                style={{ backgroundColor: EDGE_COLORS[type] }}
              />
              <span className="flex-1">{type}</span>
              <span className="text-ink-500">{stats.byEdgeType[type] ?? 0}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
