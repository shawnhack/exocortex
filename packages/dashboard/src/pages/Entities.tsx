import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useToast } from "../components/Toast";
import { tagColor } from "../utils/tagColor";

export function Entities() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const lastClickedIdx = useRef<number | null>(null);

  const { data: tagsData } = useQuery({
    queryKey: ["entity-tags"],
    queryFn: () => api.getEntityTags(),
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["entities", selectedTags],
    queryFn: () => api.getEntities(selectedTags.length > 0 ? { tags: selectedTags } : undefined),
  });

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleCardClick = useCallback((id: string, idx: number, e: React.MouseEvent) => {
    if (!selectMode) return;
    const results = data?.results;
    if (!results) return;

    if (e.shiftKey && lastClickedIdx.current !== null) {
      // Shift-click: range select between last clicked and current
      const start = Math.min(lastClickedIdx.current, idx);
      const end = Math.max(lastClickedIdx.current, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          next.add(results[i].id);
        }
        return next;
      });
    } else {
      // Normal click: toggle single
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
    lastClickedIdx.current = idx;
  }, [selectMode, data]);

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
        queryClient.invalidateQueries({ queryKey: ["entity-tags"] });
        queryClient.invalidateQueries({ queryKey: ["stats"] });
      } catch {
        toast("Failed to delete entities", "error");
      } finally {
        setDeleting(false);
      }
    });
  };

  const allTags = tagsData?.tags ?? [];

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
              lastClickedIdx.current = null;
            }}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        )}
      </div>

      {/* Tag filter pills */}
      {allTags.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
          <button
            className={`filter-pill${selectedTags.length === 0 ? " active" : ""}`}
            onClick={() => setSelectedTags([])}
          >
            All
          </button>
          {allTags.map((tag) => {
            const color = tagColor(tag);
            const isActive = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                className={`filter-pill${isActive ? " active" : ""}`}
                onClick={() => toggleTag(tag)}
                style={isActive ? { borderColor: color, color } : undefined}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {selectMode && (
        <p style={{ color: "#8080a0", fontSize: 12, marginBottom: 12, fontFamily: "var(--font-mono)" }}>
          Click to select. Shift+click for range. Esc to cancel.
        </p>
      )}

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
        {data?.results.map((entity, idx) => {
          const entityTags = entity.tags ?? [];
          const borderColor = entityTags.length > 0 ? tagColor(entityTags[0]) : "#16163a";
          const selected = selectedIds.has(entity.id);
          const CardWrapper = selectMode ? "div" : Link;
          const cardProps = selectMode
            ? { onClick: (e: React.MouseEvent) => handleCardClick(entity.id, idx, e) }
            : { to: `/entities/${entity.id}`, style: { textDecoration: "none" } };
          return (
            <CardWrapper
              key={entity.id}
              {...(cardProps as any)}
            >
              <div
                style={{
                  background: selected ? "rgba(34, 211, 238, 0.05)" : "#0c0c1d",
                  border: `1px solid ${selected ? "rgba(34, 211, 238, 0.35)" : "#16163a"}`,
                  borderLeft: `3px solid ${selected ? "#22d3ee" : borderColor}`,
                  borderRadius: 10,
                  padding: "14px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  transition: "all 0.15s",
                  cursor: "pointer",
                  userSelect: selectMode ? "none" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {selectMode && (
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        border: `2px solid ${selected ? "#22d3ee" : "#16163a"}`,
                        background: selected ? "#22d3ee" : "transparent",
                        transition: "all 0.2s",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {selected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  )}
                  <div>
                    <span style={{ fontWeight: 600, color: "#e8e8f4", fontSize: 14 }}>
                      {entity.name}
                    </span>
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
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {entityTags.length > 0 ? (
                    entityTags.map((tag) => {
                      const color = tagColor(tag);
                      return (
                        <span
                          key={tag}
                          style={{
                            background: `${color}20`,
                            color,
                            padding: "3px 10px",
                            borderRadius: 20,
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          {tag}
                        </span>
                      );
                    })
                  ) : (
                    <span style={{ color: "#5a5a78", fontSize: 11, fontStyle: "italic" }}>
                      no tags
                    </span>
                  )}
                </div>
              </div>
            </CardWrapper>
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
            border: "1px solid rgba(34, 211, 238, 0.3)",
            borderRadius: 14,
            padding: "10px 20px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 24px rgba(34, 211, 238, 0.08)",
            zIndex: 100,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: selectedIds.size > 0 ? "#67e8f9" : "#8080a0",
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
              lastClickedIdx.current = null;
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
