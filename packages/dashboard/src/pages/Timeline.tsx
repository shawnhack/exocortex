import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { MemoryCard } from "../components/MemoryCard";
import { useToast } from "../components/Toast";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { parseUTC } from "../utils/format";

function formatDate(dateStr: string): string {
  // dateStr is a local date group key like "2026-02-03" — parse as local, not UTC
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function groupByDate(memories: Array<{ created_at: string; [key: string]: unknown }>) {
  const groups: Record<string, typeof memories> = {};
  for (const m of memories) {
    // Group by local date so timeline days match the user's timezone
    const d = parseUTC(m.created_at);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!groups[date]) groups[date] = [];
    groups[date].push(m);
  }
  return Object.entries(groups);
}

export function Timeline() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast, confirmToast } = useToast();
  const [page, setPage] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["recent", page],
    queryFn: () => api.getRecent(limit, page * limit),
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
    confirmToast(`Delete ${selectedIds.size} selected memories?`, async () => {
      setDeleting(true);
      try {
        await Promise.all([...selectedIds].map((id) => api.deleteMemory(id)));
        toast(`Deleted ${selectedIds.size} memories`, "success");
        setSelectedIds(new Set());
        setSelectMode(false);
        queryClient.invalidateQueries({ queryKey: ["recent"] });
      } catch {
        toast("Failed to delete memories", "error");
      } finally {
        setDeleting(false);
      }
    });
  };

  useKeyboardShortcuts({
    ArrowLeft: () => { if (data && page > 0) setPage((p) => p - 1); },
    ArrowRight: () => { if (data && data.count >= limit) setPage((p) => p + 1); },
    Escape: () => {
      if (selectMode) {
        setSelectMode(false);
        setSelectedIds(new Set());
      }
    },
  });

  const dateGroups = data ? groupByDate(data.results as any) : [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <h1>Timeline</h1>
          <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 24 }}>
            Recent memories in reverse chronological order
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {selectMode && selectedIds.size > 0 && (
            <button
              className="btn-danger btn-sm"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : `Delete ${selectedIds.size} selected`}
            </button>
          )}
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setSelectMode(!selectMode);
              setSelectedIds(new Set());
            }}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        </div>
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

      {/* Date-grouped timeline */}
      {dateGroups.map(([date, memories]) => (
        <div key={date} style={{ marginBottom: 24 }}>
          {/* Date header with accent line */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 12,
              position: "sticky",
              top: 0,
              background: "#06060e",
              paddingTop: 8,
              paddingBottom: 8,
              zIndex: 1,
            }}
          >
            <div
              style={{
                width: 3,
                height: 20,
                borderRadius: 2,
                background: "linear-gradient(180deg, #8b5cf6, #22d3ee)",
              }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#a0a0be",
                fontFamily: "var(--font-mono)",
              }}
            >
              {formatDate(date)}
            </span>
          </div>

          {/* Cards under this date */}
          <div style={{ paddingLeft: 15, borderLeft: "1px solid #16163a" }}>
            {(memories as any[]).map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                selectable={selectMode}
                selected={selectedIds.has(memory.id)}
                onToggle={toggleSelect}
                onTagClick={(tag) => navigate(`/?tag=${encodeURIComponent(tag)}`)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Pagination */}
      {data && (
        <div style={{ display: "flex", gap: 10, marginTop: 20, alignItems: "center" }}>
          <button
            className="btn-ghost"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <button
            className="btn-ghost"
            disabled={data.results.length < limit}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
          <span
            style={{
              color: "#8080a0",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            Page {page + 1}
          </span>
        </div>
      )}
    </div>
  );
}
