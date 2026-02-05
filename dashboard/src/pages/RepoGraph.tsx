import { useState, useEffect, useRef, useMemo, useCallback, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import { getRepoGraph, submitForceReindex, connectIndexWebSocket, cancelIndex, getRepoMeta } from "../api/client";
import type { GraphNode, GraphLink, GraphNodeLabel, GraphEdgeType, GraphView, RepoMeta } from "../api/client";
import GraphLegend, {
  NODE_COLORS,
  EDGE_COLORS,
  NODE_SIZES,
} from "../components/GraphLegend";
import { advanceJourneyStep } from "../journey";

// Extended node type with force-graph positional data
type FGNode = GraphNode & { x?: number; y?: number; z?: number; __connections?: number };
type FGLink = GraphLink & { source: string | FGNode; target: string | FGNode };

interface IndexJobState {
  id: string;
  phase: string;
  percentage: number;
  filesProcessed: number;
  totalFiles: number;
  functionsIndexed: number;
  error?: string;
}

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

// Dispose all GPU resources in a Three.js group
function disposeGroup(group: THREE.Group) {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    } else if (child instanceof THREE.Sprite) {
      child.material.dispose();
    }
  });
}

const MAX_RENDER_NODES = 8000;
const MAX_RENDER_LINKS = 20000;
const LARGE_GRAPH_NODES = 5000;
const LARGE_GRAPH_LINKS = 12000;
const LEGEND_WIDTH = 256;
const LEGEND_GUTTER = 24;

export default function RepoGraph() {
  const { repoId } = useParams<{ repoId: string }>();
  const decodedRepoId = repoId ? decodeURIComponent(repoId) : "";

  const fgRef = useRef<ForceGraphMethods>();
  const containerRef = useRef<HTMLDivElement>(null);
  const hasZoomedRef = useRef(false);

  const [graphData, setGraphData] = useState<{ nodes: FGNode[]; links: FGLink[] } | null>(null);
  const [graphView, setGraphView] = useState<GraphView>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [refreshKey, setRefreshKey] = useState(0);

  const [reindexOpen, setReindexOpen] = useState(false);
  const [reindexEmail, setReindexEmail] = useState("");
  const [reindexToken, setReindexToken] = useState("");
  const [reindexBranch, setReindexBranch] = useState("");
  const [reindexError, setReindexError] = useState("");
  const [reindexLoading, setReindexLoading] = useState(false);
  const [reindexCancelling, setReindexCancelling] = useState(false);
  const [reindexJob, setReindexJob] = useState<IndexJobState | null>(null);
  const reindexCleanupRef = useRef<(() => void) | null>(null);
  const [repoMeta, setRepoMeta] = useState<RepoMeta | null>(null);
  const [repoMetaError, setRepoMetaError] = useState("");
  const [repoMetaLoading, setRepoMetaLoading] = useState(false);

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

  // Cache Three.js node objects to prevent mass re-creation on hover
  const nodeObjectsRef = useRef<Map<string, THREE.Group>>(new Map());
  const prevHighlightRef = useRef<Set<string>>(new Set());

  const graphInset = useMemo(() => {
    if (dimensions.width < 900) return 12;
    return LEGEND_WIDTH + LEGEND_GUTTER;
  }, [dimensions.width]);

  const graphWidth = Math.max(320, dimensions.width - graphInset);
  const graphHeight = dimensions.height;

  useEffect(() => {
    void advanceJourneyStep("explore");
  }, []);

  useEffect(() => {
    return () => {
      reindexCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!reindexOpen || !decodedRepoId) return;
    let active = true;
    setRepoMetaLoading(true);
    setRepoMetaError("");
    getRepoMeta(decodedRepoId)
      .then((meta) => {
        if (!active) return;
        setRepoMeta(meta);
        if (!reindexBranch && meta.branch) {
          setReindexBranch(meta.branch);
        }
      })
      .catch((err) => {
        if (!active) return;
        setRepoMeta(null);
        setRepoMetaError(err instanceof Error ? err.message : "Failed to load repo metadata");
      })
      .finally(() => {
        if (!active) return;
        setRepoMetaLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reindexOpen, decodedRepoId]);

  useEffect(() => {
    if (graphView !== "overview") return;
    setNodeFilters((prev) => ({ ...prev, File: true, Function: false, Class: false }));
    setEdgeFilters((prev) => ({
      ...prev,
      CALLS: true,
      IMPORTS: true,
      EXTENDS: true,
      IMPLEMENTS: true,
      CONTAINS: false,
      HAS_METHOD: false,
    }));
  }, [graphView]);

  // Fetch graph data
  useEffect(() => {
    if (!decodedRepoId) return;
    let active = true;
    setLoading(true);
    setError("");
    setGraphData(null);
    setSelectedNode(null);
    setHoveredNode(null);

    // Dispose previous graph's Three.js objects before loading new data
    for (const group of nodeObjectsRef.current.values()) {
      disposeGroup(group);
    }
    nodeObjectsRef.current.clear();
    prevHighlightRef.current.clear();
    hasZoomedRef.current = false;

    getRepoGraph(decodedRepoId, graphView)
      .then((data) => {
        if (!active) return;
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
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load graph");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [decodedRepoId, graphView, refreshKey]);

  // Dispose all cached Three.js objects on unmount
  useEffect(() => {
    return () => {
      for (const group of nodeObjectsRef.current.values()) {
        disposeGroup(group);
      }
      nodeObjectsRef.current.clear();
    };
  }, []);

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

  const { renderData, renderInfo } = useMemo(() => {
    const totalNodes = filteredData.nodes.length;
    const totalLinks = filteredData.links.length;
    if (totalNodes <= MAX_RENDER_NODES && totalLinks <= MAX_RENDER_LINKS) {
      return {
        renderData: filteredData,
        renderInfo: {
          capped: false,
          totalNodes,
          totalLinks,
          renderNodes: totalNodes,
          renderLinks: totalLinks,
        },
      };
    }

    const degree = new Map<string, number>();
    for (const link of filteredData.links) {
      const srcId = typeof link.source === "object" ? link.source.id : link.source;
      const tgtId = typeof link.target === "object" ? link.target.id : link.target;
      if (srcId) degree.set(srcId, (degree.get(srcId) ?? 0) + 1);
      if (tgtId) degree.set(tgtId, (degree.get(tgtId) ?? 0) + 1);
    }

    const sortedNodes = [...filteredData.nodes].sort(
      (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
    );
    const limitedNodes = sortedNodes.slice(0, MAX_RENDER_NODES);
    const keepIds = new Set(limitedNodes.map((n) => n.id));
    const limitedLinks = filteredData.links
      .filter((link) => {
        const srcId = typeof link.source === "object" ? link.source.id : link.source;
        const tgtId = typeof link.target === "object" ? link.target.id : link.target;
        return keepIds.has(srcId!) && keepIds.has(tgtId!);
      })
      .slice(0, MAX_RENDER_LINKS);

    return {
      renderData: { nodes: limitedNodes, links: limitedLinks },
      renderInfo: {
        capped: true,
        totalNodes,
        totalLinks,
        renderNodes: limitedNodes.length,
        renderLinks: limitedLinks.length,
      },
    };
  }, [filteredData]);

  const isLargeGraph =
    renderInfo.capped ||
    filteredData.nodes.length > LARGE_GRAPH_NODES ||
    filteredData.links.length > LARGE_GRAPH_LINKS;

  const useCustomNodes = !isLargeGraph;
  const enableHighlight = !isLargeGraph;
  const reindexIsTerminal = reindexJob?.phase === "complete" || reindexJob?.phase === "failed";
  const reindexIsRunning = !!reindexJob && !reindexIsTerminal;

  // Zoom to fit once data loads
  useEffect(() => {
    if (!renderData.nodes.length || !fgRef.current) return;
    // Set initial camera position looking at origin from a distance
    const distance = Math.max(300, Math.sqrt(renderData.nodes.length) * 15);
    fgRef.current.cameraPosition({ x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 0);

    const timer = setTimeout(() => {
      if (!fgRef.current) return;
      // Calculate centroid of all nodes
      let cx = 0, cy = 0, cz = 0;
      let count = 0;
      for (const node of renderData.nodes as FGNode[]) {
        if (node.x != null && node.y != null && node.z != null) {
          cx += node.x;
          cy += node.y;
          cz += node.z;
          count++;
        }
      }
      if (count > 0) {
        cx /= count;
        cy /= count;
        cz /= count;
      }
      // Position camera to look at centroid
      const camDist = Math.max(400, Math.sqrt(renderData.nodes.length) * 18);
      fgRef.current.cameraPosition(
        { x: cx, y: cy, z: cz + camDist },
        { x: cx, y: cy, z: cz },
        800
      );
      hasZoomedRef.current = true;
    }, 500);
    return () => clearTimeout(timer);
  }, [renderData, graphWidth, graphHeight]);

  // Search: zoom to first matching node
  useEffect(() => {
    if (!searchQuery.trim() || !fgRef.current) return;
    const q = searchQuery.toLowerCase();
    const match = renderData.nodes.find(
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
  }, [searchQuery, renderData]);

  const adjacency = useMemo(() => {
    const map = new Map<string, { nodeIds: Set<string>; linkKeys: Set<string> }>();
    if (!enableHighlight) return map;
    for (const link of renderData.links) {
      const srcId = typeof link.source === "object" ? link.source.id : link.source;
      const tgtId = typeof link.target === "object" ? link.target.id : link.target;
      if (!srcId || !tgtId) continue;
      const key = `${srcId}-${tgtId}`;

      const srcEntry = map.get(srcId) ?? { nodeIds: new Set<string>(), linkKeys: new Set<string>() };
      srcEntry.nodeIds.add(srcId);
      srcEntry.nodeIds.add(tgtId);
      srcEntry.linkKeys.add(key);
      map.set(srcId, srcEntry);

      const tgtEntry = map.get(tgtId) ?? { nodeIds: new Set<string>(), linkKeys: new Set<string>() };
      tgtEntry.nodeIds.add(tgtId);
      tgtEntry.nodeIds.add(srcId);
      tgtEntry.linkKeys.add(key);
      map.set(tgtId, tgtEntry);
    }
    return map;
  }, [renderData, enableHighlight]);

  // Connected node/link IDs for highlighting
  const highlightSet = useMemo(() => {
    const nodeIds = new Set<string>();
    const linkKeys = new Set<string>();
    const active = selectedNode || hoveredNode;
    if (!active) return { nodeIds, linkKeys };
    nodeIds.add(active.id);
    if (!enableHighlight) return { nodeIds, linkKeys };

    const entry = adjacency.get(active.id);
    if (!entry) return { nodeIds, linkKeys };
    for (const id of entry.nodeIds) nodeIds.add(id);
    for (const key of entry.linkKeys) linkKeys.add(key);
    return { nodeIds, linkKeys };
  }, [selectedNode, hoveredNode, adjacency, enableHighlight]);

  const renderNodeIdSet = useMemo(() => {
    return new Set(renderData.nodes.map((n) => n.id));
  }, [renderData]);

  useEffect(() => {
    if (selectedNode && !renderNodeIdSet.has(selectedNode.id)) {
      setSelectedNode(null);
    }
    if (hoveredNode && !renderNodeIdSet.has(hoveredNode.id)) {
      setHoveredNode(null);
    }
  }, [renderNodeIdSet, selectedNode, hoveredNode]);

  // Node custom object: sphere + glow sprite (STABLE - no highlight dependency)
  // Highlight rings are managed separately via useEffect to avoid rebuilding
  // all Three.js objects on every hover (which causes a severe memory leak).
  const nodeThreeObject = useCallback(
    (node: FGNode) => {
      const cached = nodeObjectsRef.current.get(node.id);
      if (cached) return cached;

      const label = node.label as GraphNodeLabel;
      const color = NODE_COLORS[label] ?? "#ffffff";
      const baseSize = NODE_SIZES[label] ?? 3;
      const connections = node.__connections ?? 0;
      const size = baseSize + Math.min(connections * 0.3, 6);

      const group = new THREE.Group();
      group.userData = { nodeId: node.id, size };

      // Core sphere
      const geometry = new THREE.SphereGeometry(size, 16, 16);
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

      nodeObjectsRef.current.set(node.id, group);
      return group;
    },
    [],
  );

  // Manage highlight rings via direct Three.js manipulation instead of
  // rebuilding all node objects (which was the source of the memory leak)
  useEffect(() => {
    if (!useCustomNodes || !enableHighlight) return;
    const prev = prevHighlightRef.current;
    const curr = highlightSet.nodeIds;

    // Remove rings from no-longer-highlighted nodes
    for (const id of prev) {
      if (!curr.has(id)) {
        const group = nodeObjectsRef.current.get(id);
        if (group) {
          const ring = group.children.find((c) => c.userData?.isHighlightRing);
          if (ring) {
            group.remove(ring);
            if (ring instanceof THREE.Mesh) {
              ring.geometry.dispose();
              (ring.material as THREE.Material).dispose();
            }
          }
        }
      }
    }

    // Add rings to newly highlighted nodes
    for (const id of curr) {
      const group = nodeObjectsRef.current.get(id);
      if (group && !group.children.some((c) => c.userData?.isHighlightRing)) {
        const size = (group.userData?.size as number) ?? 3;
        const ringGeo = new THREE.RingGeometry(size * 1.4, size * 1.7, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.userData = { isHighlightRing: true };
        ring.lookAt(0, 0, 1);
        group.add(ring);
      }
    }

    prevHighlightRef.current = new Set(curr);
  }, [highlightSet, useCustomNodes, enableHighlight]);

  useEffect(() => {
    if (useCustomNodes) return;
    for (const group of nodeObjectsRef.current.values()) {
      disposeGroup(group);
    }
    nodeObjectsRef.current.clear();
    prevHighlightRef.current.clear();
  }, [useCustomNodes]);

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

  const simpleNodeColor = useCallback((node: FGNode) => {
    return NODE_COLORS[node.label as GraphNodeLabel] ?? "#ffffff";
  }, []);

  const simpleNodeVal = useCallback((node: FGNode) => {
    const label = node.label as GraphNodeLabel;
    const baseSize = NODE_SIZES[label] ?? 3;
    const connections = node.__connections ?? 0;
    const scale = isLargeGraph ? 1.9 : 1.2;
    return baseSize * scale + Math.min(connections * 0.25, 6);
  }, [isLargeGraph]);

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

  const handleNodeHover = useCallback(
    (node: object | null) => {
      if (!enableHighlight) return;
      setHoveredNode(node as FGNode | null);
    },
    [enableHighlight],
  );

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const buildReindexToken = useCallback(() => {
    const trimmedEmail = reindexEmail.trim();
    const trimmedToken = reindexToken.trim();
    if (trimmedEmail) return `${trimmedEmail}:${trimmedToken}`;
    return trimmedToken;
  }, [reindexEmail, reindexToken]);

  const handleForceReindex = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (!decodedRepoId) return;
      setReindexError("");
      setReindexLoading(true);
      setReindexCancelling(false);

      try {
        const fullToken = buildReindexToken();
        if (!fullToken) {
          throw new Error("Provide a token to force re-index.");
        }

        const branchValue = reindexBranch.trim();
        const { indexId } = await submitForceReindex({
          repoId: decodedRepoId,
          token: fullToken,
          branch: branchValue || undefined,
        });

        setReindexJob({
          id: indexId,
          phase: "queued",
          percentage: 0,
          filesProcessed: 0,
          totalFiles: 0,
          functionsIndexed: 0,
        });

        reindexCleanupRef.current?.();
        reindexCleanupRef.current = connectIndexWebSocket(indexId, (event) => {
          setReindexJob((prev) => {
            if (!prev) return prev;
            const phase = (event.phase as string) ?? prev.phase;
            const nextError =
              typeof event.error === "string" ? event.error : phase === "failed" ? prev.error : undefined;
            return {
              ...prev,
              phase,
              percentage: (event.percentage as number) ?? prev.percentage,
              filesProcessed: (event.filesProcessed as number) ?? prev.filesProcessed,
              totalFiles: (event.totalFiles as number) ?? prev.totalFiles,
              functionsIndexed: (event.functionsIndexed as number) ?? prev.functionsIndexed,
              error: nextError,
            };
          });

          const phase = event.phase as string | undefined;
          if (phase === "complete" || phase === "failed") {
            reindexCleanupRef.current?.();
            if (phase === "complete") {
              setRefreshKey((prev) => prev + 1);
            }
          }
        });
      } catch (err) {
        setReindexError(err instanceof Error ? err.message : "Failed to start re-index");
      } finally {
        setReindexLoading(false);
      }
    },
    [decodedRepoId, reindexBranch, buildReindexToken],
  );

  const handleReindexCancel = useCallback(async () => {
    if (!reindexJob || reindexCancelling) return;
    setReindexCancelling(true);
    setReindexError("");
    try {
      await cancelIndex(reindexJob.id);
    } catch (err) {
      setReindexError(err instanceof Error ? err.message : "Failed to cancel re-index");
    } finally {
      setReindexCancelling(false);
    }
  }, [reindexJob, reindexCancelling]);

  // Link color with highlight dimming
  const linkColor = useCallback(
    (link: FGLink) => {
      const base = EDGE_COLORS[link.type as GraphEdgeType] ?? "#6b7280";
      if (!enableHighlight) return base;
      const active = selectedNode || hoveredNode;
      if (!active) return base;
      const srcId = typeof link.source === "object" ? (link.source as FGNode).id : link.source;
      const tgtId = typeof link.target === "object" ? (link.target as FGNode).id : link.target;
      const key = `${srcId}-${tgtId}`;
      return highlightSet.linkKeys.has(key) ? base : "rgba(50,50,50,0.15)";
    },
    [enableHighlight, highlightSet, selectedNode, hoveredNode],
  );

  // Link width with highlight
  const linkWidth = useCallback(
    (link: FGLink) => {
      const baseWidth = isLargeGraph ? 0.7 : 0.55;
      const weight = typeof link.weight === "number" ? link.weight : 1;
      const weightBoost = Math.min(1.2, Math.log1p(weight) * 0.12);
      const weightedBase = baseWidth + weightBoost;
      if (!enableHighlight) return weightedBase;
      const active = selectedNode || hoveredNode;
      if (!active) return weightedBase;
      const srcId = typeof link.source === "object" ? (link.source as FGNode).id : link.source;
      const tgtId = typeof link.target === "object" ? (link.target as FGNode).id : link.target;
      const key = `${srcId}-${tgtId}`;
      return highlightSet.linkKeys.has(key) ? 1.5 : 0.15;
    },
    [enableHighlight, highlightSet, isLargeGraph, selectedNode, hoveredNode],
  );

  // Directional particles on highlighted links
  const linkParticles = useCallback(
    (link: FGLink) => {
      if (!enableHighlight) return 0;
      const active = selectedNode || hoveredNode;
      if (!active) return 0;
      const srcId = typeof link.source === "object" ? (link.source as FGNode).id : link.source;
      const tgtId = typeof link.target === "object" ? (link.target as FGNode).id : link.target;
      const key = `${srcId}-${tgtId}`;
      return highlightSet.linkKeys.has(key) ? 3 : 0;
    },
    [enableHighlight, highlightSet, selectedNode, hoveredNode],
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
        const strength = isLargeGraph ? -60 : -120;
        (charge as any).strength(strength).distanceMax(500);
      }
      const link = fg.d3Force("link");
      if (link && typeof link === "function" && "distance" in link) {
        (link as any).distance(isLargeGraph ? 30 : 40);
      }
      // Add centering force to pull nodes toward origin
      const center = fg.d3Force("center");
      if (center && typeof center === "function") {
        (center as any).strength(1);
      }
    } catch {
      // Force configuration may not be available
    }
  }, [renderData, isLargeGraph]);

  if (loading) {
    return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-warm-50">
        <div className="text-center">
          <div className="relative mx-auto mb-6 h-20 w-20">
            <div
              className="absolute inset-0 border-2 border-transparent"
              style={{
                borderTopColor: NODE_COLORS.File,
                borderRightColor: NODE_COLORS.Function,
                borderBottomColor: NODE_COLORS.Class,
                animation: "spin 1.2s linear infinite",
              }}
            />
            <div
              className="absolute inset-2 border-2 border-transparent"
              style={{
                borderTopColor: NODE_COLORS.Class,
                borderLeftColor: NODE_COLORS.File,
                animation: "spin 0.9s linear infinite reverse",
              }}
            />
            <div
              className="absolute inset-4 border-2 border-transparent"
              style={{
                borderBottomColor: NODE_COLORS.Function,
                animation: "spin 1.5s linear infinite",
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="h-3 w-3"
                style={{ backgroundColor: NODE_COLORS.File, boxShadow: `0 0 12px ${NODE_COLORS.File}` }}
              />
            </div>
          </div>
          <p className="text-sm text-ink-700 tracking-wide">Loading knowledge graph...</p>
          <p className="text-xs text-ink-600 mt-1 font-mono">{decodedRepoId}</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center">
        <div className="p-6 bg-rose-50 border border-rose-400/50">
          <p className="text-rose-700 text-sm mb-2">Failed to load graph</p>
          <p className="text-rose-600/80 text-xs font-mono">{error}</p>
        </div>
        <Link to="/repos" className="inline-block mt-6 text-sm text-ink-600 hover:text-ink-900 transition-colors">
          Back to repositories
        </Link>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-y-0 right-0 left-64"
      style={{ background: "#fbf8f2" }}
    >
      {/* Breadcrumb overlay */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-4">
        <button
          type="button"
          onClick={() => {
            setReindexError("");
            setReindexOpen(true);
          }}
          disabled={!decodedRepoId || reindexIsRunning}
          className="inline-flex items-center gap-2 border border-rose-500/60 bg-white px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.3em] text-rose-700 transition hover:border-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
          title="Delete existing graph + embeddings and rebuild"
        >
          {reindexIsRunning ? "Re-indexing…" : "Force Re-index"}
        </button>
        <Link
          to={`/repo/${encodeURIComponent(decodedRepoId)}/docs`}
          className="inline-flex items-center gap-2 border border-ink-900 bg-white px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-700 transition hover:bg-warm-100"
        >
          Docs
        </Link>
        <div className="flex items-center gap-3">
          <Link
            to="/repos"
            className="text-xs text-ink-600 hover:text-ink-900 transition-colors font-mono"
          >
            repos
          </Link>
          <span className="text-ink-500 text-xs">/</span>
          <span className="text-xs text-ink-700 font-mono truncate max-w-[300px]">
            {decodedRepoId}
          </span>
        </div>
      </div>

      {reindexOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/30 backdrop-blur-[1px]">
          <div className="w-full max-w-lg border border-ink-900 bg-white p-6 shadow-[0_18px_60px_rgba(15,23,42,0.2)]">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.35em] text-rose-700">Force Re-index</div>
                <h2 className="mt-2 text-lg font-semibold text-ink-950">Rebuild knowledge graph</h2>
                <p className="mt-2 text-xs text-ink-600">
                  This wipes the existing graph + embeddings for{" "}
                  <span className="font-mono text-ink-900">{decodedRepoId}</span> and rebuilds from scratch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReindexOpen(false)}
                className="text-xs text-ink-500 hover:text-ink-900 transition-colors"
              >
                Close
              </button>
            </div>

            <div className="mt-4 border border-ink-900/10 bg-warm-100/60 p-3 text-xs text-ink-700">
              <div className="text-[10px] uppercase tracking-[0.3em] text-ink-500">Repo metadata</div>
              {repoMetaLoading && (
                <div className="mt-2 text-ink-500">Loading metadata…</div>
              )}
              {!repoMetaLoading && repoMeta && (
                <div className="mt-2 space-y-1">
                  <div><span className="text-ink-500">Repo ID:</span> <span className="font-mono">{repoMeta.repoId}</span></div>
                  <div><span className="text-ink-500">Repo URL:</span> <span className="font-mono">{repoMeta.repoUrl}</span></div>
                  {repoMeta.branch && (
                    <div><span className="text-ink-500">Branch:</span> <span className="font-mono">{repoMeta.branch}</span></div>
                  )}
                  {repoMeta.framework && (
                    <div><span className="text-ink-500">Framework:</span> <span className="font-mono">{repoMeta.framework}</span></div>
                  )}
                  {repoMeta.updatedAt && (
                    <div><span className="text-ink-500">Updated:</span> <span className="font-mono">{repoMeta.updatedAt}</span></div>
                  )}
                </div>
              )}
              {!repoMetaLoading && !repoMeta && (
                <div className="mt-2 text-rose-700">
                  No repo metadata found. Run a full index from the Indexing page to seed it.
                </div>
              )}
              {repoMetaError && (
                <div className="mt-2 text-rose-700">{repoMetaError}</div>
              )}
            </div>

            <form onSubmit={handleForceReindex} className="mt-5 space-y-4">
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-600">
                  Email (optional)
                </label>
                <input
                  type="email"
                  value={reindexEmail}
                  onChange={(e) => setReindexEmail(e.target.value)}
                  placeholder="you@company.com"
                  disabled={reindexIsRunning}
                  className="mt-2 w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-600">
                  App Password / Token
                </label>
                <input
                  type="password"
                  value={reindexToken}
                  onChange={(e) => setReindexToken(e.target.value)}
                  placeholder="Bitbucket app password"
                  disabled={reindexIsRunning}
                  className="mt-2 w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-600">
                  Branch (optional)
                </label>
                <input
                  type="text"
                  value={reindexBranch}
                  onChange={(e) => setReindexBranch(e.target.value)}
                  placeholder="main"
                  disabled={reindexIsRunning}
                  className="mt-2 w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500 disabled:opacity-60"
                />
              </div>

              {reindexError && (
                <div className="border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                  {reindexError}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={reindexLoading || reindexIsRunning}
                  className="inline-flex flex-1 items-center justify-center gap-2 border border-rose-600 bg-rose-600 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reindexLoading ? "Starting…" : reindexIsRunning ? "Re-indexing…" : "Start Re-index"}
                </button>
                {reindexJob && !reindexIsTerminal && (
                  <button
                    type="button"
                    onClick={handleReindexCancel}
                    disabled={reindexCancelling}
                    className="inline-flex items-center justify-center gap-2 border border-rose-400/60 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-rose-700 transition hover:border-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {reindexCancelling ? "Cancelling…" : "Cancel"}
                  </button>
                )}
              </div>
            </form>

            {reindexJob && (
              <div className="mt-5 border border-ink-900 bg-white p-4">
                <div className="flex justify-between text-xs text-ink-600 mb-2">
                  <span>Phase: {reindexJob.phase}</span>
                  <span className="tabular-nums">{reindexJob.percentage}%</span>
                </div>
                <div className="h-1.5 w-full bg-warm-200">
                  <div
                    className={`h-full ${reindexJob.phase === "failed" ? "bg-rose-500" : "bg-brand-500"}`}
                    style={{ width: `${reindexJob.percentage}%` }}
                  />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-ink-700">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-ink-500">Files</div>
                    <div className="mt-1 font-semibold tabular-nums">
                      {reindexJob.filesProcessed}/{reindexJob.totalFiles}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-ink-500">Functions</div>
                    <div className="mt-1 font-semibold tabular-nums">{reindexJob.functionsIndexed}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-ink-500">Status</div>
                    <div className={`mt-1 font-semibold ${reindexJob.phase === "failed" ? "text-rose-600" : reindexJob.phase === "complete" ? "text-emerald-600" : "text-brand-600"}`}>
                      {reindexJob.phase}
                    </div>
                  </div>
                </div>

                {reindexJob.error && (
                  <div className="mt-3 border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                    {reindexJob.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Legend + controls */}
      <GraphLegend
        graphView={graphView}
        onGraphViewChange={setGraphView}
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
        renderInfo={renderInfo}
        simplified={isLargeGraph}
        stats={stats}
      />

      {/* Selected node detail panel */}
      {selectedNode && (
        <div className="absolute bottom-6 left-4 z-10 w-72 bg-white border border-ink-900 p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 flex-shrink-0"
                style={{ backgroundColor: NODE_COLORS[selectedNode.label], boxShadow: `0 0 8px ${NODE_COLORS[selectedNode.label]}` }}
              />
              <span className="text-[10px] uppercase tracking-wider text-ink-600">
                {selectedNode.label}
              </span>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-ink-600 hover:text-ink-900 text-xs transition-colors"
            >
              close
            </button>
          </div>
          <p className="text-sm text-ink-900 font-mono truncate mb-2" title={selectedNode.name}>
            {selectedNode.name}
          </p>
          <div className="space-y-1 text-xs text-ink-600 font-mono">
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
              <p className="text-rose-700">extends {selectedNode.extendsName}</p>
            )}
            {selectedNode.isExported && <p className="text-emerald-700">exported</p>}
            {selectedNode.isAsync && <p className="text-sky-700">async</p>}
            {selectedNode.propertyCount != null && (
              <p>{selectedNode.propertyCount} properties, {selectedNode.methodCount ?? 0} methods</p>
            )}
          </div>
          <div className="mt-3 pt-2 border-t border-ink-900 text-[10px] text-ink-500">
            {selectedNode.__connections ?? 0} connections
          </div>
        </div>
      )}

      {/* 3D Force Graph */}
      <div
        className="absolute inset-y-0 flex items-center justify-center"
        style={{ left: graphInset, right: 0 }}
      >
        <ForceGraph3D
          ref={fgRef}
          width={graphWidth}
          height={graphHeight}
          graphData={renderData}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          onEngineStop={() => {
            if (hasZoomedRef.current || !fgRef.current) return;
            // Calculate centroid of all nodes after simulation settles
            const nodes = renderData.nodes as FGNode[];
            let cx = 0, cy = 0, cz = 0;
            let count = 0;
            for (const node of nodes) {
              if (node.x != null && node.y != null && node.z != null) {
                cx += node.x;
                cy += node.y;
                cz += node.z;
                count++;
              }
            }
            if (count > 0) {
              cx /= count;
              cy /= count;
              cz /= count;
            }
            const camDist = Math.max(400, Math.sqrt(nodes.length) * 18);
            fgRef.current.cameraPosition(
              { x: cx, y: cy, z: cz + camDist },
              { x: cx, y: cy, z: cz },
              800
            );
            hasZoomedRef.current = true;
          }}
          nodeThreeObject={useCustomNodes ? nodeThreeObject : undefined}
          nodeThreeObjectExtend={useCustomNodes ? false : undefined}
          nodeColor={!useCustomNodes ? simpleNodeColor : undefined}
          nodeVal={!useCustomNodes ? simpleNodeVal : undefined}
          nodeLabel={enableHighlight ? nodeLabel : undefined}
          nodeVisibility={nodeVisibility}
          onNodeClick={handleNodeClick}
          onNodeHover={enableHighlight ? handleNodeHover : undefined}
          onBackgroundClick={handleBackgroundClick}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkOpacity={isLargeGraph ? 0.6 : 0.75}
          linkDirectionalParticles={enableHighlight ? linkParticles : 0}
          linkDirectionalParticleWidth={enableHighlight ? 1.5 : 0}
          linkDirectionalParticleSpeed={enableHighlight ? 0.006 : 0}
          linkDirectionalParticleColor={enableHighlight ? linkColor : undefined}
          linkDirectionalArrowLength={enableHighlight ? 3 : 0}
          linkDirectionalArrowRelPos={enableHighlight ? 1 : 0}
          linkDirectionalArrowColor={enableHighlight ? linkColor : undefined}
          enableNodeDrag={!isLargeGraph}
          enableNavigationControls={true}
          cooldownTicks={isLargeGraph ? 40 : 200}
          d3AlphaDecay={isLargeGraph ? 0.07 : 0.02}
          d3VelocityDecay={isLargeGraph ? 0.5 : 0.3}
        />
      </div>
    </div>
  );
}
