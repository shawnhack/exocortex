import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useToast } from "../components/Toast";

const ENTITY_TYPES = ["", "person", "project", "technology", "organization", "concept"] as const;

const TYPE_LABELS: Record<string, string> = {
  "": "All",
  person: "Person",
  project: "Project",
  technology: "Tech",
  organization: "Org",
  concept: "Concept",
};

const TYPE_COLORS: Record<string, { border: string; badge: string; badgeBg: string }> = {
  person: { border: "#22d3ee", badge: "#22d3ee", badgeBg: "rgba(34, 211, 238, 0.15)" },
  technology: { border: "#8b5cf6", badge: "#8b5cf6", badgeBg: "rgba(139, 92, 246, 0.15)" },
  project: { border: "#34d399", badge: "#34d399", badgeBg: "rgba(52, 211, 153, 0.15)" },
  organization: { border: "#fbbf24", badge: "#fbbf24", badgeBg: "rgba(251, 191, 36, 0.15)" },
  concept: { border: "#f472b6", badge: "#f472b6", badgeBg: "rgba(244, 114, 182, 0.15)" },
};

const DEFAULT_COLOR = { border: "#16163a", badge: "#8080a0", badgeBg: "rgba(90, 90, 120, 0.15)" };

export function Entities() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [type, setType] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["entities", type],
    queryFn: () => api.getEntities(type || undefined),
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    confirmToast(`Delete ${selectedIds.size} selected entities?`, async () => {
      setDeleting(true);
      try {
        await Promise.all([...selectedIds].map((id) => api.deleteEntity(id)));
        toast(`Deleted ${selectedIds.size} entities`, "success");
        setSelectedIds(new Set());
        setSelectMode(false);
        queryClient.invalidateQueries({ queryKey: ["entities"] });
        queryClient.invalidateQueries({ queryKey: ["stats"] });
      } catch {
        toast("Failed to delete entities", "error");
      } finally {
        setDeleting(false);
      }
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <h1>Entities</h1>
          <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 20 }}>
            Extracted knowledge graph nodes
          </p>
        </div>
        {data && data.results.length > 0 && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setSelectMode(!selectMode);
              setSelectedIds(new Set());
            }}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        )}
      </div>

      {/* Filter pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {ENTITY_TYPES.map((t) => (
          <button
            key={t}
            className={`filter-pill${type === t ? " active" : ""}`}
            onClick={() => setType(t)}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="loading">
          <div className="spinner" />
          <span>Loading...</span>
        </div>
      )}

      {error && (
        <p style={{ color: "#f87171", fontSize: 14 }}>
          Error: {(error as Error).message}
        </p>
      )}

      {data && data.results.length === 0 && (
        <div className="empty-state">
          <h3>No entities yet</h3>
          <p>Entities are created when the intelligence layer extracts them from memories.</p>
        </div>
      )}

      {/* Entity cards */}
      <div style={{ display: "grid", gap: 10, marginBottom: selectMode ? 80 : 0 }}>
        {data?.results.map((entity) => {
          const colors = TYPE_COLORS[entity.type] ?? DEFAULT_COLOR;
          const selected = selectedIds.has(entity.id);
          return (
            <div
              key={entity.id}
              onClick={selectMode ? () => toggleSelect(entity.id) : undefined}
              style={{
                background: selected ? "rgba(139, 92, 246, 0.05)" : "#0c0c1d",
                border: `1px solid ${selected ? "rgba(139, 92, 246, 0.35)" : "#16163a"}`,
                borderLeft: `3px solid ${colors.border}`,
                borderRadius: 10,
                padding: "14px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                transition: "all 0.15s",
                cursor: selectMode ? "pointer" : undefined,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {selectMode && (
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      border: `2px solid ${selected ? "#8b5cf6" : "#16163a"}`,
                      background: selected ? "#8b5cf6" : "transparent",
                      transition: "all 0.2s",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {selected && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                )}
                <div>
                  {selectMode ? (
                    <span style={{ fontWeight: 600, color: "#e8e8f4", fontSize: 14 }}>
                      {entity.name}
                    </span>
                  ) : (
                    <Link
                      to={`/entities/${entity.id}`}
                      style={{
                        fontWeight: 600,
                        color: "#e8e8f4",
                        textDecoration: "none",
                        fontSize: 14,
                      }}
                    >
                      {entity.name}
                    </Link>
                  )}
                  {entity.aliases.length > 0 && (
                    <span
                      style={{
                        color: "#8080a0",
                        fontSize: 12,
                        marginLeft: 8,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      ({entity.aliases.join(", ")})
                    </span>
                  )}
                </div>
              </div>
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
          );
        })}
      </div>

      {/* Floating select action bar */}
      {selectMode && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#0c0c1d",
            border: "1px solid rgba(139, 92, 246, 0.3)",
            borderRadius: 14,
            padding: "10px 20px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 24px rgba(139, 92, 246, 0.08)",
            zIndex: 100,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: selectedIds.size > 0 ? "#a78bfa" : "#8080a0",
              fontWeight: 600,
              minWidth: 90,
            }}
          >
            {selectedIds.size} selected
          </span>

          <div style={{ width: 1, height: 20, background: "#16163a" }} />

          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              if (data && selectedIds.size === data.results.length) {
                setSelectedIds(new Set());
              } else if (data) {
                setSelectedIds(new Set(data.results.map((e) => e.id)));
              }
            }}
          >
            {data && selectedIds.size === data.results.length ? "Deselect all" : "Select all"}
          </button>

          <button
            className="btn-danger btn-sm"
            onClick={handleBulkDelete}
            disabled={deleting || selectedIds.size === 0}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {deleting && <span className="spinner" style={{ width: 12, height: 12 }} />}
            {deleting ? "Deleting..." : "Delete"}
          </button>

          <div style={{ width: 1, height: 20, background: "#16163a" }} />

          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setSelectMode(false);
              setSelectedIds(new Set());
            }}
            style={{ color: "#8080a0" }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
