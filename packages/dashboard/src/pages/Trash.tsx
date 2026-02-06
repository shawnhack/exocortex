import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useToast } from "../components/Toast";
import { timeAgo } from "../utils/format";

export function Trash() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["archived", page],
    queryFn: () => api.getArchived(limit, page * limit),
  });

  const handleRestore = async (id: string) => {
    try {
      await api.restoreMemory(id);
      toast("Memory restored", "success");
      queryClient.invalidateQueries({ queryKey: ["archived"] });
      queryClient.invalidateQueries({ queryKey: ["recent"] });
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    } catch {
      toast("Failed to restore memory", "error");
    }
  };

  const handlePermanentDelete = async (id: string) => {
    try {
      await api.deleteMemory(id);
      toast("Memory permanently deleted", "success");
      queryClient.invalidateQueries({ queryKey: ["archived"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    } catch {
      toast("Failed to delete memory", "error");
    }
  };

  return (
    <div>
      <h1>Trash</h1>
      <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 24 }}>
        Archived and superseded memories
      </p>

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
          <h3>Trash is empty</h3>
          <p>Deleted and superseded memories will appear here.</p>
        </div>
      )}

      {data && data.results.length > 0 && (
        <div>
          <p style={{ color: "#8080a0", fontSize: 13, fontFamily: "var(--font-mono)", marginBottom: 12 }}>
            {data.count} item{data.count !== 1 ? "s" : ""}
          </p>

          {data.results.map((memory) => (
            <div
              key={memory.id}
              style={{
                background: "#0c0c1d",
                border: "1px solid #16163a",
                borderRadius: 10,
                padding: 16,
                marginBottom: 8,
                opacity: 0.7,
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.7"; }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Link
                  to={`/memory/${memory.id}`}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "#22d3ee",
                    letterSpacing: "0.02em",
                    opacity: 0.8,
                  }}
                >
                  {memory.id.slice(0, 13)}
                </Link>
                <span style={{ fontSize: 11, color: "#8080a0", fontFamily: "var(--font-mono)" }}>
                  {timeAgo(memory.updated_at)}
                </span>
              </div>

              <div
                style={{
                  color: "#d0d0e0",
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  fontSize: 13,
                  marginBottom: 12,
                }}
              >
                {memory.content}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => handleRestore(memory.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  Restore
                </button>
                <button
                  className="btn-danger btn-sm"
                  onClick={() => handlePermanentDelete(memory.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  Delete Forever
                </button>
              </div>
            </div>
          ))}

          {/* Pagination */}
          <div style={{ display: "flex", gap: 10, marginTop: 20, alignItems: "center" }}>
            <button className="btn-ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button className="btn-ghost" disabled={data.count < limit} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
            <span style={{ color: "#8080a0", fontSize: 12, fontFamily: "var(--font-mono)" }}>
              Page {page + 1}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
