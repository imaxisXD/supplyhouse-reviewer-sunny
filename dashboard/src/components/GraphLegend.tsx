import type { GraphNodeLabel, GraphEdgeType } from "../api/client";

export const NODE_COLORS: Record<GraphNodeLabel, string> = {
  File: "#3b82f6",
  Function: "#22c55e",
  Class: "#a855f7",
};

export const EDGE_COLORS: Record<GraphEdgeType, string> = {
  CONTAINS: "#6b7280",
  CALLS: "#22c55e",
  IMPORTS: "#3b82f6",
  HAS_METHOD: "#f97316",
  EXTENDS: "#ef4444",
  IMPLEMENTS: "#eab308",
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
    <div className="absolute top-4 left-4 z-10 w-64 bg-gray-900/95 backdrop-blur-sm border border-gray-700 rounded-lg shadow-xl overflow-hidden">
      {/* Search */}
      <div className="p-3 border-b border-gray-800">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search nodes..."
          className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Stats */}
      <div className="px-3 py-2 border-b border-gray-800 flex gap-4 text-xs text-gray-400">
        <span>{stats.totalNodes} nodes</span>
        <span>{stats.totalLinks} edges</span>
      </div>

      {/* Node types */}
      <div className="p-3 border-b border-gray-800">
        <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Node Types</p>
        <div className="space-y-1.5">
          {(Object.keys(NODE_COLORS) as GraphNodeLabel[]).map((label) => (
            <label
              key={label}
              className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer hover:text-white transition-colors"
            >
              <input
                type="checkbox"
                checked={nodeFilters[label]}
                onChange={() => onToggleNode(label)}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 h-3 w-3"
              />
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: NODE_COLORS[label] }}
              />
              <span className="flex-1">{label}</span>
              <span className="text-gray-500">{stats.byNodeType[label] ?? 0}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Edge types */}
      <div className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Edge Types</p>
        <div className="space-y-1.5">
          {(Object.keys(EDGE_COLORS) as GraphEdgeType[]).map((type) => (
            <label
              key={type}
              className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer hover:text-white transition-colors"
            >
              <input
                type="checkbox"
                checked={edgeFilters[type]}
                onChange={() => onToggleEdge(type)}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 h-3 w-3"
              />
              <span
                className="w-4 h-0.5 flex-shrink-0 rounded"
                style={{ backgroundColor: EDGE_COLORS[type] }}
              />
              <span className="flex-1">{type}</span>
              <span className="text-gray-500">{stats.byEdgeType[type] ?? 0}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
