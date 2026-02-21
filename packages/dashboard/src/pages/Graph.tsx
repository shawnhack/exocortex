import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Entity } from "../api/client";
import { tagColor } from "../utils/tagColor";

interface Node {
  id: string;
  name: string;
  tags: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface Edge {
  source: string;
  target: string;
  label: string;
}

const DEFAULT_COLOR = "#8b5cf6";

const hexToRgba = (hex: string, alpha: number): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export function Graph() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const animRef = useRef<number>(0);
  const animRunningRef = useRef(false);
  const dragRef = useRef<{ node: Node | null; offsetX: number; offsetY: number }>({ node: null, offsetX: 0, offsetY: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const isPanningRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const alphaRef = useRef(1);
  const hoveredRef = useRef<Node | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [legendTags, setLegendTags] = useState<string[]>([]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["entity-graph"],
    queryFn: () => api.getEntityGraph(),
  });

  // Initialize nodes and edges from data
  useEffect(() => {
    if (!data) return;

    const { entities, relationships } = data;
    const w = containerRef.current?.clientWidth ?? 800;
    const h = containerRef.current?.clientHeight ?? 600;

    const nodes: Node[] = entities.map((e, i) => {
      const angle = (2 * Math.PI * i) / entities.length;
      const r = Math.min(w, h) * 0.35;
      return {
        id: e.id,
        name: e.name,
        tags: e.tags ?? [],
        x: w / 2 + r * Math.cos(angle) + (Math.random() - 0.5) * 40,
        y: h / 2 + r * Math.sin(angle) + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
        radius: 6,
      };
    });

    const nodeSet = new Set(nodes.map((n) => n.id));
    const edges: Edge[] = relationships
      .filter((r) => nodeSet.has(r.source_id) && nodeSet.has(r.target_id))
      .map((r) => ({
        source: r.source_id,
        target: r.target_id,
        label: r.relationship,
      }));

    nodesRef.current = nodes;
    edgesRef.current = edges;
    setNodeCount(nodes.length);
    setEdgeCount(edges.length);

    // Build legend from distinct first tags
    const distinctTags = new Set<string>();
    for (const node of nodes) {
      if (node.tags.length > 0) distinctTags.add(node.tags[0]);
    }
    setLegendTags([...distinctTags].sort());

    // Center pan
    panRef.current = { x: 0, y: 0 };
    scaleRef.current = 1;
  }, [data]);

  // Force simulation + rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    alphaRef.current = 1;
    const ALPHA_DECAY = 0.998;
    const ALPHA_MIN = 0.001;

    function tick() {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      if (nodes.length === 0) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      const w = canvas!.clientWidth / 2;
      const h = canvas!.clientHeight / 2;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // Only run physics while simulation is warm
      const alpha = alphaRef.current;
      if (alpha > ALPHA_MIN) {
        const REPULSION = 600;
        const ATTRACTION = 0.008;
        const DAMPING = 0.7;
        const CENTER_PULL = 0.0008;
        const TARGET_LEN = 140;

        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            let dx = nodes[j].x - nodes[i].x;
            let dy = nodes[j].y - nodes[i].y;
            const distSq = dx * dx + dy * dy;
            if (distSq === 0) {
              dx = (Math.random() - 0.5) * 0.1;
              dy = (Math.random() - 0.5) * 0.1;
            }
            const dist = Math.sqrt(distSq) || 0.1;
            const force = (REPULSION * alpha) / (distSq || 0.01);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            nodes[i].vx -= fx;
            nodes[i].vy -= fy;
            nodes[j].vx += fx;
            nodes[j].vy += fy;
          }
        }

        // Attraction along edges
        for (const edge of edges) {
          const s = nodeMap.get(edge.source);
          const t = nodeMap.get(edge.target);
          if (!s || !t) continue;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (dist - TARGET_LEN) * ATTRACTION * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          s.vx += fx;
          s.vy += fy;
          t.vx -= fx;
          t.vy -= fy;
        }

        // Center pull + damping + integration
        for (const node of nodes) {
          if (dragRef.current.node === node) continue;
          node.vx += (w - node.x) * CENTER_PULL * alpha;
          node.vy += (h - node.y) * CENTER_PULL * alpha;
          node.vx *= DAMPING;
          node.vy *= DAMPING;
          node.x += node.vx;
          node.y += node.vy;
        }

        alphaRef.current = alpha * ALPHA_DECAY;
      }

      // Render
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas!.clientWidth;
      const ch = canvas!.clientHeight;
      if (canvas!.width !== cw * dpr || canvas!.height !== ch * dpr) {
        canvas!.width = cw * dpr;
        canvas!.height = ch * dpr;
      }

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, cw, ch);

      ctx!.save();
      ctx!.translate(panRef.current.x, panRef.current.y);
      ctx!.scale(scaleRef.current, scaleRef.current);

      // Draw edges
      for (const edge of edges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (!s || !t) continue;
        ctx!.beginPath();
        ctx!.moveTo(s.x, s.y);
        ctx!.lineTo(t.x, t.y);
        ctx!.strokeStyle = "rgba(139, 92, 246, 0.12)";
        ctx!.lineWidth = 1;
        ctx!.stroke();
      }

      // Draw nodes
      const hovered = hoveredRef.current;
      for (const node of nodes) {
        const color = node.tags.length > 0 ? tagColor(node.tags[0]) : DEFAULT_COLOR;
        const isHovered = hovered === node;
        const r = isHovered ? 9 : node.radius;

        // Glow
        if (isHovered) {
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
          ctx!.fillStyle = hexToRgba(color, 0.15);
          ctx!.fill();
        }

        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = color;
        ctx!.fill();

        // Label
        ctx!.font = `${isHovered ? "600 12px" : "11px"} system-ui, sans-serif`;
        ctx!.fillStyle = isHovered ? "#e8e8f4" : "#a0a0be";
        ctx!.textAlign = "center";
        ctx!.fillText(node.name, node.x, node.y + r + 14);
      }

      ctx!.restore();

      if (alphaRef.current > ALPHA_MIN) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        animRunningRef.current = false;
      }
    }

    function startAnimation() {
      if (animRunningRef.current) return;
      animRunningRef.current = true;
      animRef.current = requestAnimationFrame(tick);
    }

    // Expose startAnimation via a ref-accessible mechanism
    (canvasRef.current as any).__startAnimation = startAnimation;

    startAnimation();
    return () => {
      animRunningRef.current = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [data]);

  // Helper to restart animation on interaction
  const startAnimation = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas && (canvas as any).__startAnimation) {
      (canvas as any).__startAnimation();
    }
  }, []);

  // Mouse interaction handlers
  const screenToWorld = useCallback((sx: number, sy: number) => {
    return {
      x: (sx - panRef.current.x) / scaleRef.current,
      y: (sy - panRef.current.y) / scaleRef.current,
    };
  }, []);

  const findNode = useCallback((wx: number, wy: number): Node | null => {
    for (const node of nodesRef.current) {
      const dx = node.x - wx;
      const dy = node.y - wy;
      if (dx * dx + dy * dy < 15 * 15) return node;
    }
    return null;
  }, []);

  // Attach wheel handler via ref with { passive: false } to reliably
  // prevent page scroll. React's synthetic onWheel is passive by default.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const zoom = e.deltaY > 0 ? 0.9 : 1.1;
      const prevScale = scaleRef.current;
      const newScale = Math.max(0.2, Math.min(5, prevScale * zoom));
      panRef.current.x = mx - (mx - panRef.current.x) * (newScale / prevScale);
      panRef.current.y = my - (my - panRef.current.y) * (newScale / prevScale);
      scaleRef.current = newScale;
      startAnimation();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [startAnimation]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x, y } = screenToWorld(sx, sy);
    const node = findNode(x, y);

    if (node) {
      dragRef.current = { node, offsetX: node.x - x, offsetY: node.y - y };
      alphaRef.current = Math.max(alphaRef.current, 0.3);
      startAnimation();
    } else {
      isPanningRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      startAnimation();
    }
  }, [screenToWorld, findNode, startAnimation]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x, y } = screenToWorld(sx, sy);

    if (dragRef.current.node) {
      dragRef.current.node.x = x + dragRef.current.offsetX;
      dragRef.current.node.y = y + dragRef.current.offsetY;
      dragRef.current.node.vx = 0;
      dragRef.current.node.vy = 0;
      startAnimation();
    } else if (isPanningRef.current) {
      panRef.current.x += e.clientX - lastMouseRef.current.x;
      panRef.current.y += e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      startAnimation();
    } else {
      const nextHovered = findNode(x, y);
      if (hoveredRef.current !== nextHovered) {
        hoveredRef.current = nextHovered;
        startAnimation();
      } else {
        hoveredRef.current = nextHovered;
      }
      canvasRef.current!.style.cursor = hoveredRef.current ? "pointer" : "grab";
    }
  }, [screenToWorld, findNode, startAnimation]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = { node: null, offsetX: 0, offsetY: 0 };
    isPanningRef.current = false;
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x, y } = screenToWorld(sx, sy);
    const node = findNode(x, y);
    if (node) navigate(`/entities/${node.id}`);
  }, [screenToWorld, findNode, navigate]);

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading graph...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="loading">
        <span>Failed to load graph data</span>
      </div>
    );
  }

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "#e8e8f4", marginBottom: 4 }}>
            Knowledge Graph
          </h1>
          <p style={{ fontSize: 13, color: "#8080a0", margin: 0 }}>
            Interactive entity relationship map. Drag nodes, scroll to zoom, double-click to navigate.
          </p>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#8080a0" }}>
          <span><strong style={{ color: "#e8e8f4" }}>{nodeCount}</strong> entities</span>
          <span><strong style={{ color: "#e8e8f4" }}>{edgeCount}</strong> connections</span>
        </div>
      </div>

      {/* Legend — dynamic from tags */}
      {legendTags.length > 0 && (
        <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
          {legendTags.map((tag) => (
            <div key={tag} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#a0a0be" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: tagColor(tag) }} />
              {tag}
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#a0a0be" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: DEFAULT_COLOR }} />
            untagged
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          background: "#06060e",
          border: "1px solid #16163a",
          borderRadius: 12,
          overflow: "hidden",
          height: "calc(100vh - 200px)",
          minHeight: 400,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", cursor: "grab" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
        />
      </div>
    </div>
  );
}
