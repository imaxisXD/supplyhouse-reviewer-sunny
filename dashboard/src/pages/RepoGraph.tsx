import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import { getRepoGraph } from "../api/client";
import type { GraphNode, GraphLink, GraphNodeLabel, GraphEdgeType } from "../api/client";
import GraphLegend, {
  NODE_COLORS,
  EDGE_COLORS,
  NODE_SIZES,
} from "../components/GraphLegend";

// Extended node type with force-graph positional data
type FGNode = GraphNode & { x?: number; y?: number; z?: number; __connections?: number };
type FGLink = GraphLink & { source: string | FGNode; target: string | FGNode };

// Glow sprite texture (cached)
let _glowTexture: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (_glowTexture) return _glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0.6)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.15)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  _glowTexture = new THREE.CanvasTexture(canvas);
  return _glowTexture;
}

export default function RepoGraph() {
  const { repoId } = useParams<{ repoId: string }>();
  const decodedRepoId = repoId ? decodeURIComponent(repoId) : "";

  const fgRef = useRef<ForceGraphMethods>();
  const containerRef = useRef<HTMLDivElement>(null);

  const [graphData, setGraphData] = useState<{ nodes: FGNode[]; links: FGLink[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Interaction state
  const [hoveredNode, setHoveredNode] = useState<FGNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<FGNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Filters
  const [nodeFilters, setNodeFilters] = useState<Record<GraphNodeLabel, boolean>>({
    File: true,
    Function: true,
    Class: true,
  });
  const [edgeFilters, setEdgeFilters] = useState<Record<GraphEdgeType, boolean>>({
    CONTAINS: true,
    CALLS: true,
    IMPORTS: true,
    HAS_METHOD: true,
    EXTENDS: true,
    IMPLEMENTS: true,
  });

  // Fetch graph data
  useEffect(() => {
    if (!decodedRepoId) return;
    setLoading(true);
    setError("");
    getRepoGraph(decodedRepoId)
      .then((data) => {
        // Pre-compute connection counts for node sizing
        const connectionCount: Record<string, number> = {};
        for (const link of data.links) {
          connectionCount[link.source] = (connectionCount[link.source] ?? 0) + 1;
          connectionCount[link.target] = (connectionCount[link.target] ?? 0) + 1;
        }
        const nodes: FGNode[] = data.nodes.map((n) => ({
          ...n,
          __connections: connectionCount[n.id] ?? 0,
        }));
        setGraphData({ nodes, links: data.links as FGLink[] });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load graph"))
      .finally(() => setLoading(false));
  }, [decodedRepoId]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });
    observer.observe(el);
    setDimensions({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Zoom to fit once data loads
  useEffect(() => {
    if (!graphData || !fgRef.current) return;
    const timer = setTimeout(() => {
      fgRef.current?.zoomToFit(800, 80);
    }, 500);
    return () => clearTimeout(timer);
  }, [graphData]);

  // Search: zoom to first matching node
  useEffect(() => {
    if (!searchQuery.trim() || !graphData || !fgRef.current) return;
    const q = searchQuery.toLowerCase();
    const match = graphData.nodes.find(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        (n.path && n.path.toLowerCase().includes(q)),
    );
    if (match && match.x != null && match.y != null && match.z != null) {
      const distance = 180;
      const distRatio = 1 + distance / (Math.hypot(match.x, match.y, match.z) || 1);
      fgRef.current.cameraPosition(
        { x: match.x * distRatio, y: match.y * distRatio, z: match.z * distRatio },
        { x: match.x, y: match.y, z: match.z },
        1200,
      );
      setSelectedNode(match);
    }
  }, [searchQuery, graphData]);

  // Connected node/link IDs for highlighting
  const highlightSet = useMemo(() => {
    const nodeIds = new Set<string>();
    const linkKeys = new Set<string>();
    const active = selectedNode || hoveredNode;
    if (!active || !graphData) return { nodeIds, linkKeys };

    nodeIds.add(active.id);
    for (const link of graphData.links) {
      const srcId = typeof link.source === "object" ? link.source.id : link.source;
      const tgtId = typeof link.target === "object" ? link.target.id : link.target;
      if (srcId === active.id || tgtId === active.id) {
        nodeIds.add(srcId!);
        nodeIds.add(tgtId!);
        linkKeys.add(`${srcId}-${tgtId}`);
      }
    }
    return { nodeIds, linkKeys };
  }, [selectedNode, hoveredNode, graphData]);

  // Stats
  const stats = useMemo(() => {
    if (!graphData) return { totalNodes: 0, totalLinks: 0, byNodeType: {}, byEdgeType: {} };
    const byNodeType: Record<string, number> = {};
    for (const n of graphData.nodes) {
      byNodeType[n.label] = (byNodeType[n.label] ?? 0) + 1;
    }
    const byEdgeType: Record<string, number> = {};
    for (const l of graphData.links) {
      byEdgeType[l.type] = (byEdgeType[l.type] ?? 0) + 1;
    }
    return {
      totalNodes: graphData.nodes.length,
      totalLinks: graphData.links.length,
      byNodeType,
      byEdgeType,
    };
  }, [graphData]);

  // Filtered graph data
  const filteredData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    const visibleNodeIds = new Set<string>();
    const nodes = graphData.nodes.filter((n) => {
      const visible = nodeFilters[n.label];
      if (visible) visibleNodeIds.add(n.id);
      return visible;
    });
    const links = graphData.links.filter((l) => {
      const srcId = typeof l.source === "object" ? l.source.id : l.source;
      const tgtId = typeof l.target === "object" ? l.target.id : l.target;
      return (
        edgeFilters[l.type] &&
        visibleNodeIds.has(srcId!) &&
        visibleNodeIds.has(tgtId!)
      );
    });
    return { nodes, links };
  }, [graphData, nodeFilters, edgeFilters]);

  // Node custom object: sphere + glow sprite
  const nodeThreeObject = useCallback(
    (node: FGNode) => {
      const label = node.label as GraphNodeLabel;
      const color = NODE_COLORS[label] ?? "#ffffff";
      const baseSize = NODE_SIZES[label] ?? 3;
      const connections = node.__connections ?? 0;
      const size = baseSize + Math.min(connections * 0.3, 6);

      const group = new THREE.Group();

      // Core sphere
      const geometry = new THREE.SphereGeometry(size, 20, 20);
      const material = new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 0.92,
      });
      const sphere = new THREE.Mesh(geometry, material);
      group.add(sphere);

      // Glow sprite
      const spriteMaterial = new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.scale.set(size * 5, size * 5, 1);
      group.add(sprite);

      // Highlight ring when selected/hovered
      const isHighlighted = highlightSet.nodeIds.has(node.id);
      if (isHighlighted) {
        const ringGeo = new THREE.RingGeometry(size * 1.4, size * 1.7, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.lookAt(0, 0, 1);
        group.add(ring);
      }

      return group;
    },
    [highlightSet],
  );

  // Node label (tooltip on hover)
  const nodeLabel = useCallback((node: FGNode) => {
    const label = node.label;
    const lines = [`<b style="color:${NODE_COLORS[label as GraphNodeLabel]}">${label}</b>: ${node.name}`];
    if (node.path) lines.push(`<span style="color:#9ca3af">Path: ${node.path}</span>`);
    if (node.startLine != null) lines.push(`<span style="color:#9ca3af">Lines: ${node.startLine}–${node.endLine ?? "?"}</span>`);
    if (node.language) lines.push(`<span style="color:#9ca3af">Lang: ${node.language}</span>`);
    if (node.isExported) lines.push(`<span style="color:#6ee7b7">exported</span>`);
    if (node.isAsync) lines.push(`<span style="color:#93c5fd">async</span>`);
    if (node.params) lines.push(`<span style="color:#9ca3af">Params: ${node.params}</span>`);
    if (node.returnType) lines.push(`<span style="color:#9ca3af">Returns: ${node.returnType}</span>`);
    if (node.extendsName) lines.push(`<span style="color:#fca5a5">extends ${node.extendsName}</span>`);
    return `<div style="background:rgba(3,7,18,0.92);padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);font-size:11px;line-height:1.6;font-family:ui-monospace,monospace;max-width:320px;pointer-events:none">${lines.join("<br/>")}</div>`;
  }, []);

  // Click: zoom to node
  const handleNodeClick = useCallback(
    (node: FGNode) => {
      setSelectedNode((prev) => (prev?.id === node.id ? null : node));
      if (node.x != null && node.y != null && node.z != null && fgRef.current) {
        const distance = 180;
        const distRatio = 1 + distance / (Math.hypot(node.x, node.y, node.z) || 1);
        fgRef.current.cameraPosition(
          { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
          { x: node.x, y: node.y, z: node.z },
          1000,
        );
      }
    },
    [],
  );

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Link color with highlight dimming
  const linkColor = useCallback(
    (link: FGLink) => {
      const base = EDGE_COLORS[link.type as GraphEdgeType] ?? "#6b7280";
      const active = selectedNode || hoveredNode;
      if (!active) return base;
      const srcId = typeof link.source === "object" ? (link.source as FGNode).id : link.source;
      const tgtId = typeof link.target === "object" ? (link.target as FGNode).id : link.target;
      const key = `${srcId}-${tgtId}`;
      return highlightSet.linkKeys.has(key) ? base : "rgba(50,50,50,0.15)";
    },
    [highlightSet, selectedNode, hoveredNode],
  );

  // Link width with highlight
  const linkWidth = useCallback(
    (link: FGLink) => {
      const active = selectedNode || hoveredNode;
      if (!active) return 0.4;
      const srcId = typeof link.source === "object" ? (link.source as FGNode).id : link.source;
      const tgtId = typeof link.target === "object" ? (link.target as FGNode).id : link.target;
      const key = `${srcId}-${tgtId}`;
      return highlightSet.linkKeys.has(key) ? 1.5 : 0.15;
    },
    [highlightSet, selectedNode, hoveredNode],
  );

  // Directional particles on highlighted links
  const linkParticles = useCallback(
    (link: FGLink) => {
      const active = selectedNode || hoveredNode;
      if (!active) return 0;
      const srcId = typeof link.source === "object" ? (link.source as FGNode).id : link.source;
      const tgtId = typeof link.target === "object" ? (link.target as FGNode).id : link.target;
      const key = `${srcId}-${tgtId}`;
      return highlightSet.linkKeys.has(key) ? 3 : 0;
    },
    [highlightSet, selectedNode, hoveredNode],
  );

  // Node visibility for dimming (keep all visible but opacity handled in threeObject)
  const nodeVisibility = useCallback(() => true, []);

  // Configure forces after mount
  useEffect(() => {
    if (!fgRef.current) return;
    const fg = fgRef.current;
    try {
      const charge = fg.d3Force("charge");
      if (charge && typeof charge === "function" && "strength" in charge) {
        (charge as any).strength(-120).distanceMax(500);
      }
      const link = fg.d3Force("link");
      if (link && typeof link === "function" && "distance" in link) {
        (link as any).distance(40);
      }
    } catch {
      // Force configuration may not be available
    }
  }, [graphData]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="relative mx-auto mb-6 h-20 w-20">
            <div
              className="absolute inset-0 rounded-full border-2 border-transparent"
              style={{
                borderTopColor: NODE_COLORS.File,
                borderRightColor: NODE_COLORS.Function,
                borderBottomColor: NODE_COLORS.Class,
                animation: "spin 1.2s linear infinite",
              }}
            />
            <div
              className="absolute inset-2 rounded-full border-2 border-transparent"
              style={{
                borderTopColor: NODE_COLORS.Class,
                borderLeftColor: NODE_COLORS.File,
                animation: "spin 0.9s linear infinite reverse",
              }}
            />
            <div
              className="absolute inset-4 rounded-full border-2 border-transparent"
              style={{
                borderBottomColor: NODE_COLORS.Function,
                animation: "spin 1.5s linear infinite",
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: NODE_COLORS.File, boxShadow: `0 0 12px ${NODE_COLORS.File}` }}
              />
            </div>
          </div>
          <p className="text-sm text-gray-400 tracking-wide">Loading knowledge graph...</p>
          <p className="text-xs text-gray-600 mt-1 font-mono">{decodedRepoId}</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center">
        <div className="p-6 bg-red-900/20 border border-red-800/50 rounded-lg">
          <p className="text-red-400 text-sm mb-2">Failed to load graph</p>
          <p className="text-red-300/70 text-xs font-mono">{error}</p>
        </div>
        <Link to="/repos" className="inline-block mt-6 text-sm text-gray-400 hover:text-white transition-colors">
          Back to repositories
        </Link>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 top-[57px]"
      style={{ background: "radial-gradient(ellipse at 50% 50%, #0a0f1e 0%, #030712 70%)" }}
    >
      {/* Breadcrumb overlay */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-3">
        <Link
          to="/repos"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors font-mono"
        >
          repos
        </Link>
        <span className="text-gray-700 text-xs">/</span>
        <span className="text-xs text-gray-300 font-mono truncate max-w-[300px]">
          {decodedRepoId}
        </span>
      </div>

      {/* Legend + controls */}
      <GraphLegend
        nodeFilters={nodeFilters}
        edgeFilters={edgeFilters}
        onToggleNode={(label) =>
          setNodeFilters((prev) => ({ ...prev, [label]: !prev[label] }))
        }
        onToggleEdge={(type) =>
          setEdgeFilters((prev) => ({ ...prev, [type]: !prev[type] }))
        }
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        stats={stats}
      />

      {/* Selected node detail panel */}
      {selectedNode && (
        <div className="absolute bottom-6 left-4 z-10 w-72 bg-gray-900/95 backdrop-blur-sm border border-gray-700 rounded-lg shadow-xl p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: NODE_COLORS[selectedNode.label], boxShadow: `0 0 8px ${NODE_COLORS[selectedNode.label]}` }}
              />
              <span className="text-[10px] uppercase tracking-wider text-gray-500">
                {selectedNode.label}
              </span>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-gray-600 hover:text-gray-300 text-xs transition-colors"
            >
              close
            </button>
          </div>
          <p className="text-sm text-white font-mono truncate mb-2" title={selectedNode.name}>
            {selectedNode.name}
          </p>
          <div className="space-y-1 text-xs text-gray-400 font-mono">
            {selectedNode.path && (
              <p className="truncate" title={selectedNode.path}>
                {selectedNode.path}
              </p>
            )}
            {selectedNode.startLine != null && (
              <p>
                L{selectedNode.startLine}
                {selectedNode.endLine != null && `–${selectedNode.endLine}`}
              </p>
            )}
            {selectedNode.language && <p>{selectedNode.language}</p>}
            {selectedNode.params && <p>({selectedNode.params})</p>}
            {selectedNode.returnType && <p>→ {selectedNode.returnType}</p>}
            {selectedNode.extendsName && (
              <p className="text-red-400">extends {selectedNode.extendsName}</p>
            )}
            {selectedNode.isExported && <p className="text-green-400">exported</p>}
            {selectedNode.isAsync && <p className="text-blue-400">async</p>}
            {selectedNode.propertyCount != null && (
              <p>{selectedNode.propertyCount} properties, {selectedNode.methodCount ?? 0} methods</p>
            )}
          </div>
          <div className="mt-3 pt-2 border-t border-gray-800 text-[10px] text-gray-600">
            {selectedNode.__connections ?? 0} connections
          </div>
        </div>
      )}

      {/* 3D Force Graph */}
      <ForceGraph3D
        ref={fgRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={filteredData}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
        nodeThreeObject={nodeThreeObject}
        nodeThreeObjectExtend={false}
        nodeLabel={nodeLabel}
        nodeVisibility={nodeVisibility}
        onNodeClick={handleNodeClick}
        onNodeHover={(node) => setHoveredNode(node as FGNode | null)}
        onBackgroundClick={handleBackgroundClick}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkOpacity={0.6}
        linkDirectionalParticles={linkParticles}
        linkDirectionalParticleWidth={1.5}
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalParticleColor={linkColor}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={linkColor}
        enableNodeDrag={true}
        enableNavigationControls={true}
        cooldownTicks={200}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
      />
    </div>
  );
}
