import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { forceX, forceY } from "d3-force";
import { api } from "../api/client";

const CYAN = "#22d3ee";
const CYAN_DIM = "rgba(34, 211, 238, 0.12)";
const BG = "#030308";
const BORDER = "#121228";
const TEXT_PRIMARY = "#e0f0f4";
const TEXT_SECONDARY = "#8899aa";
const TEXT_DIM = "#667788";

function nodeColor(degree: number): string {
  if (degree >= 8) return CYAN;
  if (degree >= 4) return "#06b6d4";
  if (degree >= 2) return "#0e7490";
  return "#0c5a6e";
}

interface NodeData {
  id: string;
  name: string;
  type: string;
  degree: number;
  betweenness: number;
  memoryCount: number;
  communityId: number | null;
  relationships: Array<{ target: string; relationship: string }>;
  val: number;
  color: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

interface LinkData {
  source: string | NodeData;
  target: string | NodeData;
  relationship: string;
}

interface TooltipState {
  node: NodeData;
  x: number;
  y: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GraphInstance = any;

export function Graph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance>(null);
  const initedRef = useRef(false);
  const showLabelsRef = useRef(true);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [search, setSearch] = useState("");
  const [showLabels, setShowLabels] = useState(true);
  showLabelsRef.current = showLabels;

  const { data: graphData, isLoading: graphLoading } = useQuery({
    queryKey: ["entity-graph"],
    queryFn: () => api.getEntityGraph(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: analysisData, isLoading: analysisLoading } = useQuery({
    queryKey: ["entity-graph-analysis"],
    queryFn: () => api.getEntityGraphAnalysis(),
    staleTime: 5 * 60 * 1000,
  });

  const isLoading = graphLoading || analysisLoading;

  // Single init effect — runs once when both queries resolve
  useEffect(() => {
    if (!graphData || !analysisData || !containerRef.current || initedRef.current) return;
    initedRef.current = true;

    const el = containerRef.current;

    // Build data
    const centralityMap = new Map(
      analysisData.centrality.map((c) => [c.entityId, c])
    );
    const communityMap = new Map<string, number>();
    for (const comm of analysisData.communities) {
      for (const m of comm.members) communityMap.set(m.entityId, comm.id);
    }
    const relMap = new Map<string, Array<{ target: string; relationship: string }>>();
    for (const r of graphData.relationships) {
      if (!relMap.has(r.source_id)) relMap.set(r.source_id, []);
      if (!relMap.has(r.target_id)) relMap.set(r.target_id, []);
      relMap.get(r.source_id)!.push({ target: r.target_id, relationship: r.relationship });
      relMap.get(r.target_id)!.push({ target: r.source_id, relationship: r.relationship });
    }
    const nameMap = new Map(graphData.entities.map((e) => [e.id, e.name]));

    const nodes: NodeData[] = graphData.entities.map((e) => {
      const c = centralityMap.get(e.id);
      const degree = c?.degree ?? 0;
      const rels = (relMap.get(e.id) || []).slice(0, 10).map((r) => ({
        target: nameMap.get(r.target) || r.target,
        relationship: r.relationship,
      }));
      return {
        id: e.id,
        name: e.name,
        type: e.type || "concept",
        degree,
        betweenness: c?.betweenness ?? 0,
        memoryCount: c?.memoryCount ?? 0,
        communityId: communityMap.get(e.id) ?? null,
        relationships: rels,
        val: Math.max(1, Math.sqrt(degree + 1) * 2),
        color: nodeColor(degree),
      };
    });

    const linkSet = new Set<string>();
    const links: LinkData[] = [];
    for (const r of graphData.relationships) {
      const key = [r.source_id, r.target_id].sort().join("|");
      if (!linkSet.has(key)) {
        linkSet.add(key);
        links.push({ source: r.source_id, target: r.target_id, relationship: r.relationship });
      }
    }

    // Build adjacency for neighborhood highlighting
    const neighbors = new Map<string, Set<string>>();
    for (const n of nodes) neighbors.set(n.id, new Set());
    for (const l of links) {
      const srcId = typeof l.source === "string" ? l.source : l.source.id;
      const tgtId = typeof l.target === "string" ? l.target : l.target.id;
      neighbors.get(srcId)?.add(tgtId);
      neighbors.get(tgtId)?.add(srcId);
    }

    let hoveredNodeId: string | null = null;

    // Init graph
    import("force-graph").then((fg2d) => {
      if (!containerRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ForceGraph = (fg2d.default as any);

      const graph = ForceGraph()(el)
        .graphData({ nodes, links })
        .nodeId("id")
        .nodeVal("val")
        .nodeLabel("")
        .backgroundColor(BG)
        .linkHoverPrecision(0)
        .linkCanvasObjectMode(() => "replace" as const)
        .linkCanvasObject((link: object, ctx: CanvasRenderingContext2D) => {
          const l = link as LinkData;
          const src = l.source as NodeData;
          const tgt = l.target as NodeData;
          if (src.x == null || tgt.x == null) return;

          const srcId = src.id;
          const tgtId = tgt.id;
          const active = hoveredNodeId && (srcId === hoveredNodeId || tgtId === hoveredNodeId);

          ctx.beginPath();
          ctx.moveTo(src.x, src.y!);
          ctx.lineTo(tgt.x, tgt.y!);
          ctx.strokeStyle = !hoveredNodeId
            ? "rgba(34, 211, 238, 0.2)"
            : active
              ? "rgba(34, 211, 238, 0.55)"
              : "rgba(34, 211, 238, 0.04)";
          ctx.lineWidth = active ? 1.5 : 0.6;
          ctx.stroke();
        })
        .nodeCanvasObject((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const n = node as NodeData;
          const radius = Math.max(2.5, Math.sqrt(n.degree + 1) * 1.5);
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          const isHover = n.id === hoveredNodeId;
          const isNeighbor = hoveredNodeId ? (neighbors.get(hoveredNodeId)?.has(n.id) ?? false) : false;
          const highlighted = !hoveredNodeId || isHover || isNeighbor;
          const dimmed = hoveredNodeId && !highlighted;

          // Save context to isolate shadow/alpha changes
          ctx.save();

          // Node circle
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          if (isHover) {
            ctx.fillStyle = "#67e8f9";
            ctx.shadowColor = "rgba(34, 211, 238, 0.5)";
            ctx.shadowBlur = 10;
          } else if (dimmed) {
            ctx.fillStyle = "rgba(14, 116, 144, 0.12)";
          } else {
            ctx.fillStyle = n.color;
          }
          ctx.fill();

          // Reset shadow before label
          ctx.restore();
          ctx.save();

          // Label
          if (showLabelsRef.current && globalScale > 0.3) {
            const baseFontSize = n.degree >= 5 ? 12 : n.degree >= 2 ? 11 : 10;
            const fontSize = baseFontSize / globalScale;
            ctx.font = `400 ${fontSize}px 'JetBrains Mono', 'Fira Code', monospace`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";

            if (isHover) {
              ctx.fillStyle = "#ffffff";
            } else if (dimmed) {
              ctx.fillStyle = TEXT_DIM;
              ctx.globalAlpha = 0.1;
            } else {
              ctx.fillStyle = n.degree >= 4 ? TEXT_PRIMARY : TEXT_SECONDARY;
              ctx.globalAlpha = n.degree >= 4 ? 0.85 : 0.55;
            }

            const text = n.name.length > 24 ? n.name.slice(0, 22) + ".." : n.name;
            ctx.fillText(text, x, y + radius + fontSize * 0.3);
          }

          ctx.restore();
        })
        .enableNodeDrag(false)
        .d3AlphaDecay(0.02)
        .d3VelocityDecay(0.3);

      graph.d3Force("charge")?.strength(-80);
      graph.d3Force("link")?.distance(45);
      graph.d3Force("x", forceX(0).strength(0.06));
      graph.d3Force("y", forceY(0).strength(0.06));
      // Three layers to prevent render loop from ever stopping:
      // 1. Large finite cooldown limits (avoid Infinity edge cases in library)
      // 2. d3AlphaMin(0) prevents d3 simulation from self-stopping
      // 3. onEngineStop safety net reheats if engine somehow stops
      graph
        .warmupTicks(80)
        .cooldownTicks(1e15)
        .cooldownTime(1e15)
        .d3AlphaMin(0)
        .onEngineStop(() => graph.d3ReheatSimulation());

      graphRef.current = graph;
      setTimeout(() => graph.zoomToFit(400, 60), 1500);

      // --- Manual hover/click detection (bypasses force-graph's broken pointer system) ---
      function findNodeAtScreen(screenX: number, screenY: number): NodeData | null {
        const rect = el.getBoundingClientRect();
        const coords = graph.screen2GraphCoords(screenX - rect.left, screenY - rect.top);
        const gx = coords.x;
        const gy = coords.y;
        const globalScale = graph.zoom?.() ?? 1;

        let closest: NodeData | null = null;
        let closestDist = Infinity;
        for (const n of nodes) {
          if (n.x == null || n.y == null) continue;
          const dx = n.x - gx;
          const dy = n.y - gy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Use actual visual radius + padding for hit area
          const nodeRadius = Math.max(2.5, Math.sqrt(n.degree + 1) * 1.5);
          const hitRadius = nodeRadius + 6 / globalScale;
          if (dist < hitRadius && dist < closestDist) {
            closestDist = dist;
            closest = n;
          }
        }
        return closest;
      }

      // --- Manual drag state ---
      let dragNode: NodeData | null = null;
      let didDrag = false;

      function onMouseMove(e: MouseEvent) {
        if (dragNode) {
          // Dragging — update node position
          const rect = el.getBoundingClientRect();
          const coords = graph.screen2GraphCoords(e.clientX - rect.left, e.clientY - rect.top);
          dragNode.fx = coords.x;
          dragNode.fy = coords.y;
          didDrag = true;
          graph.d3ReheatSimulation();
          return;
        }

        const node = findNodeAtScreen(e.clientX, e.clientY);
        const newId = node?.id ?? null;
        if (newId !== hoveredNodeId) {
          hoveredNodeId = newId;
          el.style.cursor = node ? "pointer" : "default";
          requestAnimationFrame(() => {
            graph.nodeColor?.(graph.nodeColor?.());
          });
        }
      }

      function onMouseDown(e: MouseEvent) {
        if (e.button !== 0) return; // left click only
        const node = findNodeAtScreen(e.clientX, e.clientY);
        if (node) {
          dragNode = node;
          didDrag = false;
          node.fx = node.x;
          node.fy = node.y;
          // Capture phase on container fires before d3-zoom on canvas —
          // stopPropagation prevents the event from reaching the canvas
          e.stopPropagation();
          e.preventDefault();
        }
      }

      function onMouseUp(e: MouseEvent) {
        if (dragNode) {
          dragNode.fx = undefined;
          dragNode.fy = undefined;
          if (!didDrag) {
            const node = dragNode;
            setTooltip((prev: TooltipState | null) =>
              prev?.node.id === node.id ? null : { node, x: e.clientX, y: e.clientY }
            );
          }
          dragNode = null;
          didDrag = false;
          return;
        }
        // Click on empty space — dismiss tooltip
        const node = findNodeAtScreen(e.clientX, e.clientY);
        if (!node) setTooltip(null);
      }

      el.addEventListener("mousemove", onMouseMove);
      // Capture phase so we intercept before d3-zoom on the canvas child
      el.addEventListener("mousedown", onMouseDown, true);
      window.addEventListener("mouseup", onMouseUp);

      // Store cleanup refs
      (graph as any).__manualCleanup = () => {
        el.removeEventListener("mousemove", onMouseMove);
        el.removeEventListener("mousedown", onMouseDown, true);
        window.removeEventListener("mouseup", onMouseUp);
      };
    });

    return () => {
      if (graphRef.current) {
        graphRef.current.__manualCleanup?.();
        graphRef.current._destructor?.();
        graphRef.current = null;
      }
    };
  }, [graphData, analysisData]);

  // Search filtering — just update node visual properties
  useEffect(() => {
    if (!graphRef.current) return;
    const graph = graphRef.current;
    const gd = graph.graphData();
    if (!gd?.nodes) return;
    const lowerSearch = search.toLowerCase();

    for (const node of gd.nodes as NodeData[]) {
      if (lowerSearch && !node.name.toLowerCase().includes(lowerSearch)) {
        node.color = "rgba(14, 116, 144, 0.1)";
        node.val = 0.5;
      } else {
        node.color = nodeColor(node.degree);
        node.val = Math.max(1, Math.sqrt(node.degree + 1) * 2);
      }
    }
    // Reheat briefly to trigger re-render without resetting positions
    graph.d3ReheatSimulation();
  }, [search]);

  // Resize
  useEffect(() => {
    const handleResize = () => {
      if (graphRef.current && containerRef.current) {
        graphRef.current.width(containerRef.current.clientWidth);
        graphRef.current.height(containerRef.current.clientHeight);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading knowledge graph...</span>
      </div>
    );
  }

  const stats = analysisData?.stats;

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <h1 style={{ margin: 0 }}>Knowledge Graph</h1>
          {stats && (
            <div style={{ display: "flex", gap: 12, fontSize: 12, color: TEXT_SECONDARY }}>
              <span><strong style={{ color: TEXT_PRIMARY, fontFamily: "var(--font-mono)" }}>{stats.nodeCount}</strong> nodes</span>
              <span><strong style={{ color: TEXT_PRIMARY, fontFamily: "var(--font-mono)" }}>{stats.edgeCount}</strong> edges</span>
              <span><strong style={{ color: TEXT_PRIMARY, fontFamily: "var(--font-mono)" }}>{stats.components}</strong> components</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search entities..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mono"
            style={{ width: 180, padding: "6px 12px", fontSize: 12 }}
          />
          <button
            onClick={() => setShowLabels((v) => !v)}
            className="btn-ghost"
            style={{
              padding: "6px 12px",
              fontSize: 12,
              color: showLabels ? CYAN : TEXT_DIM,
              borderColor: showLabels ? "rgba(34, 211, 238, 0.3)" : BORDER,
              background: showLabels ? CYAN_DIM : "transparent",
            }}
          >
            Labels
          </button>
          <button
            onClick={() => graphRef.current?.zoomToFit(400, 60)}
            className="btn-ghost"
            style={{ padding: "6px 12px", fontSize: 12 }}
          >
            Fit
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 400,
          background: BG,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          overflow: "hidden",
          position: "relative",
        }}
      />

      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: Math.min(tooltip.x + 12, window.innerWidth - 320),
            top: Math.min(tooltip.y - 20, window.innerHeight - 300),
            zIndex: 1000,
            padding: 14,
            background: "rgba(8, 8, 20, 0.95)",
            border: "1px solid rgba(34, 211, 238, 0.2)",
            borderRadius: 10,
            backdropFilter: "blur(12px)",
            pointerEvents: "none",
            minWidth: 200,
            maxWidth: 300,
            boxShadow: "0 0 30px rgba(34, 211, 238, 0.08), 0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: TEXT_PRIMARY, marginBottom: 4 }}>
            {tooltip.node.name}
          </div>
          <span className="badge badge-cyan" style={{ fontSize: 10, marginBottom: 8 }}>
            {tooltip.node.type}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {[
              ["Connections", tooltip.node.degree],
              ["Memories", tooltip.node.memoryCount],
              ["Betweenness", tooltip.node.betweenness.toFixed(4)],
              ...(tooltip.node.communityId !== null ? [["Community", `#${tooltip.node.communityId}`]] : []),
            ].map(([label, value]) => (
              <div key={label as string} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span style={{ color: TEXT_SECONDARY }}>{label}</span>
                <span style={{ color: TEXT_PRIMARY, fontFamily: "var(--font-mono)", fontWeight: 500 }}>{value}</span>
              </div>
            ))}
          </div>
          {tooltip.node.relationships.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${BORDER}` }}>
              <div style={{ fontSize: 10, color: TEXT_DIM, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                Relationships
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {tooltip.node.relationships.map((r, i) => (
                  <span key={i} style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    background: CYAN_DIM,
                    borderRadius: 4,
                    color: TEXT_SECONDARY,
                    border: `1px solid ${BORDER}`,
                  }}>
                    {r.relationship} {r.target}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
