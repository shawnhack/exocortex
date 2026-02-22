import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { MemoryCard } from "../components/MemoryCard";
import { tagColor } from "../utils/tagColor";

const DEFAULT_COLOR = "#16163a";

function RelationshipGraph({
  entityName,
  entityTags,
  relationships,
}: {
  entityName: string;
  entityTags: string[];
  relationships: Array<{ entity: { id: string; name: string; type: string; tags?: string[] }; relationship: string; direction: "outgoing" | "incoming" }>;
}) {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const width = 520;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 155;
  const centerColor = entityTags.length > 0 ? tagColor(entityTags[0]) : "#22d3ee";

  // Collect distinct tags for glow filters
  const allColors = new Set<string>();
  allColors.add(centerColor);
  for (const rel of relationships) {
    const relTags = (rel.entity as any).tags ?? [];
    allColors.add(relTags.length > 0 ? tagColor(relTags[0]) : "#8080a0");
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", maxWidth: 520, height: "auto" }}>
      <defs>
        {[...allColors].map((color, i) => (
          <filter key={i} id={`glow-${i}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feFlood floodColor={color} floodOpacity="0.3" />
            <feComposite in2="blur" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ))}
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
        const relTags = (rel.entity as any).tags ?? [];
        const nodeColor = relTags.length > 0 ? tagColor(relTags[0]) : "#8080a0";
        return (
          <g key={`line-${rel.entity.id}`}>
            <line
              x1={cx} y1={cy} x2={x} y2={y}
              stroke={isHovered ? nodeColor : "#16163a"}
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
                  fill={isHovered ? nodeColor : "#8080a0"}
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                  style={{ transition: "fill 0.2s" }}
                >
                  {rel.relationship}
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
        const relTags = (rel.entity as any).tags ?? [];
        const nodeColor = relTags.length > 0 ? tagColor(relTags[0]) : "#8080a0";
        const isHovered = hoveredNode === rel.entity.id;
        const colorArr = [...allColors];
        const filterIdx = colorArr.indexOf(nodeColor);
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
                stroke={nodeColor}
                strokeWidth={isHovered ? 2 : 1.5}
                filter={isHovered && filterIdx >= 0 ? `url(#glow-${filterIdx})` : undefined}
                style={{ transition: "r 0.2s, stroke-width 0.2s" }}
              />
              <text
                x={x} y={y + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={nodeColor}
                fontSize={isHovered ? 11 : 10}
                fontWeight={600}
                style={{ transition: "font-size 0.2s" }}
              >
                {rel.entity.name.length > 10 ? rel.entity.name.slice(0, 9) + "\u2026" : rel.entity.name}
              </text>
              {relTags.length > 0 && (
                <text
                  x={x} y={y + 42}
                  textAnchor="middle"
                  fill="#8080a0"
                  fontSize={8}
                  fontFamily="var(--font-mono)"
                >
                  {relTags[0]}
                </text>
              )}
            </g>
          </Link>
        );
      })}

      {/* Center node — always on top */}
      <circle
        cx={cx} cy={cy} r={40}
        fill="#08081a"
        stroke={centerColor}
        strokeWidth={2.5}
        filter={`url(#glow-${[...allColors].indexOf(centerColor)})`}
      />
      <circle
        cx={cx} cy={cy} r={38}
        fill="none"
        stroke={centerColor}
        strokeWidth={0.5}
        opacity={0.3}
      />
      <text
        x={cx} y={cy + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={centerColor}
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
  rel: { entity: { id: string; name: string; type: string; tags?: string[] }; relationship: string; direction: "outgoing" | "incoming" };
}) {
  const [hovered, setHovered] = useState(false);
  const relTags = (rel.entity as any).tags ?? [];
  const nodeColor = relTags.length > 0 ? tagColor(relTags[0]) : "#8080a0";

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
        background: hovered ? "rgba(34, 211, 238, 0.04)" : "transparent",
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
      <span style={{ color: hovered ? nodeColor : "#8080a0", transition: "color 0.15s", fontSize: 11 }}>
        {rel.direction === "outgoing" ? "\u2192" : "\u2190"}
      </span>
      <Link
        to={`/entities/${rel.entity.id}`}
        style={{
          color: nodeColor,
          textDecoration: "none",
          fontWeight: 600,
          transition: "opacity 0.15s",
          opacity: hovered ? 1 : 0.85,
        }}
      >
        {rel.entity.name}
      </Link>
      {relTags.length > 0 && (
        <div style={{ display: "flex", gap: 4 }}>
          {relTags.map((tag: string) => {
            const c = tagColor(tag);
            return (
              <span
                key={tag}
                style={{
                  background: `${c}20`,
                  color: c,
                  padding: "1px 8px",
                  borderRadius: 20,
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {tag}
              </span>
            );
          })}
        </div>
      )}
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

function TagEditor({ tags, onSave, isPending }: { tags: string[]; onSave: (tags: string[]) => void; isPending: boolean }) {
  const [newTag, setNewTag] = useState("");

  const addTag = () => {
    const tag = newTag.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      onSave([...tags, tag]);
    }
    setNewTag("");
  };

  const removeTag = (tag: string) => {
    onSave(tags.filter((t) => t !== tag));
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {tags.map((tag) => {
        const color = tagColor(tag);
        return (
          <span
            key={tag}
            style={{
              background: `${color}20`,
              color,
              padding: "4px 10px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {tag}
            <button
              onClick={() => removeTag(tag)}
              disabled={isPending}
              style={{
                background: "none",
                border: "none",
                color,
                cursor: "pointer",
                padding: 0,
                fontSize: 14,
                lineHeight: 1,
                opacity: 0.7,
              }}
              aria-label={`Remove ${tag}`}
            >
              &times;
            </button>
          </span>
        );
      })}
      <form
        onSubmit={(e) => { e.preventDefault(); addTag(); }}
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <input
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="add tag..."
          disabled={isPending}
          style={{
            background: "transparent",
            border: "1px solid #16163a",
            borderRadius: 20,
            padding: "4px 12px",
            fontSize: 12,
            color: "#e8e8f4",
            outline: "none",
            width: 100,
          }}
        />
      </form>
    </div>
  );
}

export function EntityDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const tagsMutation = useMutation({
    mutationFn: ({ id: eid, tags }: { id: string; tags: string[] }) => api.updateEntity(eid, { tags }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-memories", id] });
      queryClient.invalidateQueries({ queryKey: ["entity-relationships", id] });
      queryClient.invalidateQueries({ queryKey: ["entity-graph"] });
      queryClient.invalidateQueries({ queryKey: ["entity-tags"] });
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
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
  const entityTags = entity.tags ?? [];
  const borderColor = entityTags.length > 0 ? tagColor(entityTags[0]) : DEFAULT_COLOR;
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
        onMouseEnter={(e) => { e.currentTarget.style.color = "#22d3ee"; }}
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
          borderLeft: `3px solid ${borderColor}`,
          borderRadius: 10,
          padding: 20,
          marginBottom: 24,
          animation: "slideUp 0.3s ease-out both",
        }}
      >
        <h1 style={{ margin: "0 0 12px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entity.name}
        </h1>

        <TagEditor
          tags={entityTags}
          onSave={(tags) => tagsMutation.mutate({ id: entity.id, tags })}
          isPending={tagsMutation.isPending}
        />

        {entity.aliases.length > 0 && (
          <p style={{ color: "#8080a0", fontSize: 13, fontFamily: "var(--font-mono)", marginTop: 12 }}>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              entityTags={entity.tags}
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
