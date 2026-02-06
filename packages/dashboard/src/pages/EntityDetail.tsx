import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { MemoryCard } from "../components/MemoryCard";

const TYPE_COLORS: Record<string, { border: string; badge: string; badgeBg: string }> = {
  person: { border: "#22d3ee", badge: "#22d3ee", badgeBg: "rgba(34, 211, 238, 0.15)" },
  technology: { border: "#8b5cf6", badge: "#8b5cf6", badgeBg: "rgba(139, 92, 246, 0.15)" },
  project: { border: "#34d399", badge: "#34d399", badgeBg: "rgba(52, 211, 153, 0.15)" },
  organization: { border: "#fbbf24", badge: "#fbbf24", badgeBg: "rgba(251, 191, 36, 0.15)" },
  concept: { border: "#f472b6", badge: "#f472b6", badgeBg: "rgba(244, 114, 182, 0.15)" },
};

const DEFAULT_COLOR = { border: "#16163a", badge: "#8080a0", badgeBg: "rgba(90, 90, 120, 0.15)" };

function RelationshipGraph({
  entityName,
  entityType,
  relationships,
}: {
  entityName: string;
  entityType: string;
  relationships: Array<{ entity: { id: string; name: string; type: string }; relationship: string; direction: "outgoing" | "incoming" }>;
}) {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const width = 520;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 155;
  const centerColors = TYPE_COLORS[entityType] ?? DEFAULT_COLOR;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", maxWidth: 520, height: "auto" }}>
      <defs>
        {/* Glow filters per color */}
        {Object.entries(TYPE_COLORS).map(([type, c]) => (
          <filter key={type} id={`glow-${type}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feFlood floodColor={c.border} floodOpacity="0.3" />
            <feComposite in2="blur" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ))}
        <filter id="glow-default" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
          <feFlood floodColor="#8080a0" floodOpacity="0.3" />
          <feComposite in2="blur" operator="in" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Subtle grid */}
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <circle cx="10" cy="10" r="0.5" fill="#16163a" opacity="0.5" />
      </pattern>
      <rect width={width} height={height} fill="url(#grid)" rx="8" />

      {/* Connection lines */}
      {relationships.map((rel, i) => {
        const angle = (2 * Math.PI * i) / relationships.length - Math.PI / 2;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        const isHovered = hoveredNode === rel.entity.id;
        const colors = TYPE_COLORS[rel.entity.type] ?? DEFAULT_COLOR;
        return (
          <g key={`line-${rel.entity.id}`}>
            <line
              x1={cx} y1={cy} x2={x} y2={y}
              stroke={isHovered ? colors.border : "#16163a"}
              strokeWidth={isHovered ? 2 : 1}
              strokeDasharray={isHovered ? "none" : "4 4"}
              style={{
                transition: "stroke 0.2s, stroke-width 0.2s",
                animation: isHovered ? "none" : "dashFlow 1.5s linear infinite",
              }}
            />
            {/* Edge label */}
            {(() => {
              const mx = cx + (x - cx) * 0.48;
              const my = cy + (y - cy) * 0.48;
              return (
                <text
                  x={mx}
                  y={my - 7}
                  textAnchor="middle"
                  fill={isHovered ? colors.badge : "#8080a0"}
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                  style={{ transition: "fill 0.2s" }}
                >
                  {rel.direction === "outgoing" ? rel.relationship : rel.relationship}
                </text>
              );
            })()}
          </g>
        );
      })}

      {/* Outer nodes */}
      {relationships.map((rel, i) => {
        const angle = (2 * Math.PI * i) / relationships.length - Math.PI / 2;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        const colors = TYPE_COLORS[rel.entity.type] ?? DEFAULT_COLOR;
        const isHovered = hoveredNode === rel.entity.id;
        const filterName = TYPE_COLORS[rel.entity.type] ? `glow-${rel.entity.type}` : "glow-default";
        return (
          <Link key={rel.entity.id} to={`/entities/${rel.entity.id}`}>
            <g
              onMouseEnter={() => setHoveredNode(rel.entity.id)}
              onMouseLeave={() => setHoveredNode(null)}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={x} cy={y}
                r={isHovered ? 32 : 28}
                fill="#08081a"
                stroke={colors.border}
                strokeWidth={isHovered ? 2 : 1.5}
                filter={isHovered ? `url(#${filterName})` : undefined}
                style={{ transition: "r 0.2s, stroke-width 0.2s" }}
              />
              <text
                x={x} y={y + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={colors.badge}
                fontSize={isHovered ? 11 : 10}
                fontWeight={600}
                style={{ transition: "font-size 0.2s" }}
              >
                {rel.entity.name.length > 10 ? rel.entity.name.slice(0, 9) + "\u2026" : rel.entity.name}
              </text>
              <text
                x={x} y={y + 42}
                textAnchor="middle"
                fill="#8080a0"
                fontSize={8}
                fontFamily="var(--font-mono)"
              >
                {rel.entity.type}
              </text>
            </g>
          </Link>
        );
      })}

      {/* Center node — always on top */}
      <circle
        cx={cx} cy={cy} r={40}
        fill="#08081a"
        stroke={centerColors.border}
        strokeWidth={2.5}
        filter={`url(#${TYPE_COLORS[entityType] ? `glow-${entityType}` : "glow-default"})`}
      />
      <circle
        cx={cx} cy={cy} r={38}
        fill="none"
        stroke={centerColors.border}
        strokeWidth={0.5}
        opacity={0.3}
      />
      <text
        x={cx} y={cy + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={centerColors.badge}
        fontSize={13}
        fontWeight={700}
      >
        {entityName.length > 10 ? entityName.slice(0, 9) + "\u2026" : entityName}
      </text>
    </svg>
  );
}

function RelationshipRow({
  rel,
}: {
  rel: { entity: { id: string; name: string; type: string }; relationship: string; direction: "outgoing" | "incoming" };
}) {
  const [hovered, setHovered] = useState(false);
  const relColors = TYPE_COLORS[rel.entity.type] ?? DEFAULT_COLOR;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        fontSize: 13,
        borderRadius: 6,
        background: hovered ? "rgba(139, 92, 246, 0.04)" : "transparent",
        transition: "background 0.15s",
      }}
    >
      <span style={{
        color: "#8080a0",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        minWidth: 90,
        textAlign: "right",
      }}>
        {rel.direction === "outgoing" ? rel.relationship : ""}
      </span>
      <span style={{ color: hovered ? relColors.badge : "#8080a0", transition: "color 0.15s", fontSize: 11 }}>
        {rel.direction === "outgoing" ? "\u2192" : "\u2190"}
      </span>
      <Link
        to={`/entities/${rel.entity.id}`}
        style={{
          color: relColors.badge,
          textDecoration: "none",
          fontWeight: 600,
          transition: "opacity 0.15s",
          opacity: hovered ? 1 : 0.85,
        }}
      >
        {rel.entity.name}
      </Link>
      <span
        style={{
          background: relColors.badgeBg,
          color: relColors.badge,
          padding: "1px 8px",
          borderRadius: 20,
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        {rel.entity.type}
      </span>
      <span style={{
        color: "#8080a0",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        minWidth: 90,
      }}>
        {rel.direction === "incoming" ? rel.relationship : ""}
      </span>
    </div>
  );
}

export function EntityDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["entity-memories", id],
    queryFn: () => api.getEntityMemories(id!),
    enabled: !!id,
  });

  const { data: relData } = useQuery({
    queryKey: ["entity-relationships", id],
    queryFn: () => api.getEntityRelationships(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <p style={{ color: "#f87171", fontSize: 14 }}>
        Error: {(error as Error).message}
      </p>
    );
  }

  if (!data) return null;

  const { entity, memories, count } = data;
  const colors = TYPE_COLORS[entity.type] ?? DEFAULT_COLOR;
  const relationships = relData?.results ?? [];

  return (
    <div>
      <Link
        to="/entities"
        style={{
          fontSize: 13,
          color: "#8080a0",
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          marginBottom: 16,
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "#8b5cf6"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "#8080a0"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to entities
      </Link>

      {/* Entity header */}
      <div
        style={{
          background: "#0c0c1d",
          border: "1px solid #16163a",
          borderLeft: `3px solid ${colors.border}`,
          borderRadius: 10,
          padding: 20,
          marginBottom: 24,
          animation: "slideUp 0.3s ease-out both",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>{entity.name}</h1>
          <span
            style={{
              background: colors.badgeBg,
              color: colors.badge,
              padding: "3px 10px",
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {entity.type}
          </span>
        </div>

        {entity.aliases.length > 0 && (
          <p style={{ color: "#8080a0", fontSize: 13, fontFamily: "var(--font-mono)" }}>
            Aliases: {entity.aliases.join(", ")}
          </p>
        )}

        <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
          <span style={{ fontSize: 12, color: "#8080a0", fontFamily: "var(--font-mono)" }}>
            ID: {entity.id.slice(0, 13)}
          </span>
          <span style={{ fontSize: 12, color: "#8080a0", fontFamily: "var(--font-mono)" }}>
            Created: {new Date(entity.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Relationships */}
      {relationships.length > 0 && (
        <div style={{ marginBottom: 24, animation: "slideUp 0.3s ease-out 0.06s both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
              <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
            </svg>
            <h2 style={{ margin: 0 }}>Relationships</h2>
          </div>
          <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 12, fontFamily: "var(--font-mono)" }}>
            {relationships.length} connection{relationships.length !== 1 ? "s" : ""}
          </p>

          {/* Relationship list */}
          <div
            style={{
              background: "#0c0c1d",
              border: "1px solid #16163a",
              borderRadius: 10,
              padding: "8px 10px",
              marginBottom: 16,
            }}
          >
            {relationships.map((rel) => (
              <RelationshipRow key={rel.entity.id + rel.relationship} rel={rel} />
            ))}
          </div>

          {/* SVG Graph */}
          <div
            style={{
              background: "#08081a",
              border: "1px solid #16163a",
              borderRadius: 10,
              padding: 20,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <RelationshipGraph
              entityName={entity.name}
              entityType={entity.type}
              relationships={relationships}
            />
          </div>
        </div>
      )}

      {/* Linked memories */}
      <div style={{ animation: "slideUp 0.3s ease-out 0.12s both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
          </svg>
          <h2 style={{ margin: 0 }}>Linked Memories</h2>
        </div>
        <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 16, fontFamily: "var(--font-mono)" }}>
          {count} memor{count !== 1 ? "ies" : "y"} linked
        </p>

        {memories.length === 0 ? (
          <div className="empty-state">
            <h3>No linked memories</h3>
            <p>This entity has not been linked to any memories yet.</p>
          </div>
        ) : (
          memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onTagClick={(tag) => navigate(`/?tag=${encodeURIComponent(tag)}`)} />
          ))
        )}
      </div>
    </div>
  );
}
