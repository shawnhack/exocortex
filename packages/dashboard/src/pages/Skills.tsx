import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Memory } from "../api/client";
import { useToast } from "../components/Toast";
import { tagColor } from "../utils/tagColor";
import { timeAgo } from "../utils/format";

function parseTitle(content: string): string {
  const firstLine = content.split("\n")[0] || "";
  return firstLine.replace(/^#+\s*/, "").replace(/^Skill:\s*/i, "").replace(/\*\*/g, "").replace(/:$/, "").trim() || "Untitled Skill";
}

function parsePreview(content: string): string {
  const lines = content.split("\n");
  const body = lines.slice(1).join("\n").trim();
  if (body.length <= 150) return body;
  return body.slice(0, 150).trimEnd() + "...";
}

export function Skills() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.getRecent(100, 0, ["skill"]),
  });

  const voteMutation = useMutation({
    mutationFn: ({ id, field, currentVal }: { id: string; field: "helpful" | "harmful"; currentVal: number }) =>
      api.updateMemory(id, { metadata: { [field]: currentVal + 1 } } as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast("Vote recorded", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const skills: Memory[] = data?.results ?? [];

  const allTags = useMemo(
    () => Array.from(new Set(skills.flatMap((s) => (s.tags ?? []).filter((t) => t !== "skill")))),
    [skills]
  );

  const filteredSkills = useMemo(
    () => filter === "all" ? skills : skills.filter((s) => s.tags?.includes(filter)),
    [skills, filter]
  );

  const handleVote = useCallback(
    (e: React.MouseEvent, id: string, field: "helpful" | "harmful", currentVal: number) => {
      e.stopPropagation();
      voteMutation.mutate({ id, field, currentVal });
    },
    [voteMutation]
  );

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading skills...</span>
      </div>
    );
  }

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "#e8e8f4", marginBottom: 4 }}>Knowledge Skills</h1>
          <p style={{ fontSize: 13, color: "#8080a0", margin: 0 }}>
            Agent-authored operational skills with vote-based governance
          </p>
        </div>
        <span
          style={{
            background: "rgba(34, 211, 238, 0.15)",
            color: "#22d3ee",
            border: "1px solid rgba(34, 211, 238, 0.3)",
            borderRadius: 20,
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
          }}
        >
          {skills.length} skill{skills.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Tag filters */}
      {allTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap" }}>
          <button
            onClick={() => setFilter("all")}
            style={{
              background: filter === "all" ? "rgba(34, 211, 238, 0.15)" : "transparent",
              color: filter === "all" ? "#22d3ee" : "#8080a0",
              border: "1px solid " + (filter === "all" ? "rgba(34, 211, 238, 0.3)" : "transparent"),
              borderRadius: 20,
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              transition: "all 0.15s",
            }}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setFilter(tag)}
              style={{
                background: filter === tag ? "rgba(34, 211, 238, 0.15)" : "transparent",
                color: filter === tag ? "#22d3ee" : "#8080a0",
                border: "1px solid " + (filter === tag ? "rgba(34, 211, 238, 0.3)" : "transparent"),
                borderRadius: 20,
                padding: "5px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                transition: "all 0.15s",
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Skills grid */}
      {filteredSkills.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "#8080a0" }}>
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#3a3a5c"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginBottom: 16 }}
          >
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          </svg>
          <div style={{ fontSize: 14, marginBottom: 8 }}>No knowledge skills found</div>
          <div style={{ fontSize: 12, color: "#5a5a7a" }}>
            Skills are created by agents via <code style={{ color: "#22d3ee" }}>memory_store</code> with the "skill" tag
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 12,
          }}
        >
          {filteredSkills.map((skill) => {
            const helpful = (skill.metadata?.helpful as number) || 0;
            const harmful = (skill.metadata?.harmful as number) || 0;
            const net = helpful - harmful;
            const displayTags = (skill.tags ?? []).filter((t) => t !== "skill");

            return (
              <div
                key={skill.id}
                onClick={() => navigate(`/memory/${skill.id}`)}
                style={{
                  background: "#0c0c1d",
                  border: "1px solid #16163a",
                  borderRadius: 10,
                  padding: 18,
                  cursor: "pointer",
                  transition: "all 0.2s",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "rgba(34, 211, 238, 0.2)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "#16163a";
                }}
              >
                {/* Title + importance */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#e8e8f4" }}>{parseTitle(skill.content)}</div>
                  <span
                    style={{
                      background: "rgba(34, 211, 238, 0.12)",
                      color: "#22d3ee",
                      padding: "2px 8px",
                      borderRadius: 10,
                      fontSize: 10,
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                      flexShrink: 0,
                    }}
                  >
                    {(skill.importance * 100).toFixed(0)}%
                  </span>
                </div>

                {/* Preview */}
                <div style={{ fontSize: 13, color: "#a0a0be", lineHeight: 1.5 }}>{parsePreview(skill.content)}</div>

                {/* Tags */}
                {displayTags.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {displayTags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: tagColor(tag),
                          background: `${tagColor(tag)}18`,
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: `1px solid ${tagColor(tag)}30`,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Footer: attribution + votes */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingTop: 10,
                    borderTop: "1px solid #16163a",
                    marginTop: 2,
                  }}
                >
                  {/* Attribution */}
                  <div style={{ fontSize: 10, color: "#5a5a7a", fontFamily: "var(--font-mono)", display: "flex", gap: 6 }}>
                    {skill.agent && <span>{skill.agent}</span>}
                    {skill.model_name && <span>· {skill.model_name}</span>}
                    <span>· {timeAgo(skill.created_at)}</span>
                  </div>

                  {/* Vote controls */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={(e) => handleVote(e, skill.id, "helpful", helpful)}
                      title="Mark as helpful"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        background: "none",
                        border: "1px solid #16163a",
                        borderRadius: 6,
                        padding: "3px 8px",
                        color: "#8080a0",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "rgba(34, 211, 238, 0.5)";
                        e.currentTarget.style.color = "#22d3ee";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "#16163a";
                        e.currentTarget.style.color = "#8080a0";
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 10v12" />
                        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
                      </svg>
                      {helpful}
                    </button>

                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        fontWeight: 600,
                        minWidth: 20,
                        textAlign: "center",
                        color: net > 0 ? "#22d3ee" : net < 0 ? "#f87171" : "#5a5a7a",
                      }}
                    >
                      {net > 0 ? "+" : ""}{net}
                    </span>

                    <button
                      onClick={(e) => handleVote(e, skill.id, "harmful", harmful)}
                      title="Mark as harmful"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        background: "none",
                        border: "1px solid #16163a",
                        borderRadius: 6,
                        padding: "3px 8px",
                        color: "#8080a0",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "rgba(248, 113, 113, 0.5)";
                        e.currentTarget.style.color = "#f87171";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "#16163a";
                        e.currentTarget.style.color = "#8080a0";
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 14V2" />
                        <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
                      </svg>
                      {harmful}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
