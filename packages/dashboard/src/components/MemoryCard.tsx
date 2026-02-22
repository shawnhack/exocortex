import { Link } from "react-router-dom";
import type { Memory } from "../api/client";

function parseUTC(dateStr: string): number {
  const normalized = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = parseUTC(dateStr);
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const FACT_TAG_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  decision: { color: "#38bdf8", bg: "rgba(56, 189, 248, 0.1)", border: "rgba(56, 189, 248, 0.2)" },
  discovery: { color: "#22d3ee", bg: "rgba(34, 211, 238, 0.1)", border: "rgba(34, 211, 238, 0.2)" },
  architecture: { color: "#34d399", bg: "rgba(52, 211, 153, 0.1)", border: "rgba(52, 211, 153, 0.2)" },
  learning: { color: "#fbbf24", bg: "rgba(251, 191, 36, 0.1)", border: "rgba(251, 191, 36, 0.2)" },
};

export function MemoryCard({
  memory,
  score,
  scoreBreakdown,
  selectable,
  selected,
  onToggle,
  onTagClick,
}: {
  memory: Memory;
  score?: number;
  scoreBreakdown?: {
    vector_score: number;
    fts_score: number;
    recency_score: number;
    frequency_score: number;
  };
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
  onTagClick?: (tag: string) => void;
}) {
  const cardContent = (
    <>
      {/* Header: ID + time */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "#22d3ee",
            letterSpacing: "0.02em",
            opacity: 0.8,
          }}
        >
          {memory.id.slice(0, 13)}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "#8080a0",
            fontFamily: "var(--font-mono)",
          }}
        >
          {timeAgo(memory.created_at)}
        </span>
      </div>

      {/* Content */}
      <div
        data-testid="memory-card-content"
        style={{
          color: "#d0d0e0",
          lineHeight: 1.65,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          display: "-webkit-box",
          WebkitLineClamp: 4,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          fontSize: 13,
        }}
      >
        {memory.content}
      </div>

      {/* Score bar */}
      {score !== undefined && (
        <div
          style={{
            height: 2,
            borderRadius: 1,
            background: "#16163a",
            overflow: "hidden",
            marginTop: 12,
          }}
          title={
            scoreBreakdown
              ? `vector: ${scoreBreakdown.vector_score.toFixed(3)} | fts: ${scoreBreakdown.fts_score.toFixed(3)} | recency: ${scoreBreakdown.recency_score.toFixed(3)} | freq: ${scoreBreakdown.frequency_score.toFixed(3)}`
              : `score: ${score.toFixed(3)}`
          }
        >
          <div
            style={{
              height: "100%",
              width: `${Math.min(score * 100, 100)}%`,
              borderRadius: 1,
              background: "linear-gradient(90deg, #06b6d4, #22d3ee)",
              transition: "width 0.4s ease-out",
              boxShadow: "0 0 6px rgba(34, 211, 238, 0.2)",
            }}
          />
        </div>
      )}

      {/* Footer: tags + metadata */}
      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 5,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {memory.tags?.map((tag) => {
          const factColor = FACT_TAG_COLORS[tag];
          return (
            <span
              key={tag}
              onClick={onTagClick ? (e) => { e.preventDefault(); e.stopPropagation(); onTagClick(tag); } : undefined}
              style={{
                background: factColor?.bg ?? "rgba(34, 211, 238, 0.08)",
                color: factColor?.color ?? "#22d3ee",
                border: `1px solid ${factColor?.border ?? "rgba(34, 211, 238, 0.12)"}`,
                padding: "1px 9px",
                borderRadius: 20,
                fontSize: 10,
                fontWeight: 600,
                cursor: onTagClick ? "pointer" : undefined,
                letterSpacing: "0.02em",
                transition: "all 0.15s",
              }}
            >
              {tag}
            </span>
          );
        })}
        <span
          style={{
            fontSize: 10,
            color: "#8080a0",
            marginLeft: "auto",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.02em",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
        >
          {memory.content_type} / {memory.source}
        </span>
      </div>
    </>
  );

  const cardStyle = {
    flex: 1,
    minWidth: 0,
    background: selected ? "rgba(34, 211, 238, 0.05)" : "#0c0c1d",
    border: `1px solid ${selected ? "rgba(34, 211, 238, 0.35)" : "#16163a"}`,
    borderRadius: 10,
    padding: 16,
    marginBottom: 8,
    transition: "all 0.25s",
    display: "block" as const,
    textDecoration: "none",
    color: "inherit",
    cursor: "pointer",
    position: "relative" as const,
    overflow: "hidden" as const,
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
    if (!selected) {
      e.currentTarget.style.borderColor = "rgba(34, 211, 238, 0.35)";
      e.currentTarget.style.boxShadow = "0 0 20px rgba(34, 211, 238, 0.06), 0 0 60px rgba(34, 211, 238, 0.02)";
      e.currentTarget.style.background = "#0e0e22";
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
    if (!selected) {
      e.currentTarget.style.borderColor = "#16163a";
      e.currentTarget.style.boxShadow = "none";
      e.currentTarget.style.background = "#0c0c1d";
    }
  };

  const cornerAccents = (
    <>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 20,
          height: 1,
          background: "linear-gradient(90deg, rgba(34, 211, 238, 0.4), transparent)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1,
          height: 20,
          background: "linear-gradient(180deg, rgba(34, 211, 238, 0.4), transparent)",
        }}
      />
    </>
  );

  // In select mode, the whole card toggles selection instead of navigating
  if (selectable) {
    return (
      <div
        data-testid="memory-card"
        onClick={() => onToggle?.(memory.id)}
        style={cardStyle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {cornerAccents}
        {/* Selection indicator */}
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            width: 20,
            height: 20,
            borderRadius: 6,
            border: `2px solid ${selected ? "#22d3ee" : "#16163a"}`,
            background: selected ? "#22d3ee" : "transparent",
            transition: "all 0.2s",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </div>
        {cardContent}
      </div>
    );
  }

  return (
    <Link
      data-testid="memory-card"
      to={`/memory/${memory.id}`}
      style={cardStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {cornerAccents}
      {cardContent}
    </Link>
  );
}
