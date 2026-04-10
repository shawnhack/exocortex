import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AgentTaskItem } from "../api/client";
import { useToast } from "../components/Toast";
import { timeAgo } from "../utils/format";

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  pending: { color: "var(--text-muted)", bg: "var(--muted-bg-subtle)" },
  assigned: { color: "var(--cyan)", bg: "var(--cyan-bg)" },
  in_progress: { color: "var(--amber)", bg: "var(--amber-bg)" },
  completed: { color: "var(--emerald)", bg: "var(--emerald-bg)" },
  failed: { color: "var(--red)", bg: "var(--red-dim)" },
  blocked: { color: "var(--purple)", bg: "rgba(168, 139, 250, 0.15)" },
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "var(--red)",
  high: "var(--rose)",
  medium: "var(--amber)",
  low: "var(--text-muted)",
};

export function Tasks() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["tasks", statusFilter],
    queryFn: () => api.getTasks({ status: statusFilter }),
  });

  const { data: stats } = useQuery({
    queryKey: ["task-stats"],
    queryFn: () => api.getTaskStats(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task-stats"] });
      setExpandedId(null);
      toast("Task deleted", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const statuses = ["all", "pending", "assigned", "in_progress", "completed", "failed"];

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading tasks...</span>
      </div>
    );
  }

  const tasks = data?.tasks ?? [];

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary-alt)", marginBottom: 4 }}>Tasks</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Agent task queue — dispatched work and coordination</p>
      </div>

      {/* Stats cards */}
      {stats && stats.total > 0 && (
        <div style={{
          display: "flex",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}>
          {Object.entries(stats.by_status).map(([status, count]) => {
            const sc = STATUS_COLORS[status] ?? STATUS_COLORS.pending;
            return (
              <div key={status} style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 10,
                padding: "10px 16px",
                minWidth: 80,
              }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: sc.color, fontVariantNumeric: "tabular-nums" }}>{count}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "capitalize" }}>{status.replace("_", " ")}</div>
              </div>
            );
          })}
          {Object.keys(stats.by_assignee).length > 0 && (
            <div style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 10,
              padding: "10px 16px",
              flex: 1,
              minWidth: 150,
            }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Active by agent</div>
              {Object.entries(stats.by_assignee).map(([agent, count]) => (
                <span key={agent} style={{ fontSize: 12, color: "var(--text-body)", marginRight: 12 }}>
                  {agent.replace("sentinel:", "")}: <strong style={{ color: "var(--cyan)" }}>{count}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Status filter */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              background: statusFilter === s ? "var(--cyan-bg)" : "transparent",
              color: statusFilter === s ? "var(--cyan)" : "var(--text-muted)",
              border: "1px solid " + (statusFilter === s ? "var(--cyan-border)" : "transparent"),
              borderRadius: 20,
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Task list */}
      {tasks.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
          No tasks in queue. The dispatcher creates tasks from active goals daily at 11 AM.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tasks.map((t: AgentTaskItem) => {
            const sc = STATUS_COLORS[t.status] ?? STATUS_COLORS.pending;
            const pc = PRIORITY_COLORS[t.priority] ?? "var(--text-muted)";
            const isExpanded = expandedId === t.id;

            return (
              <div
                key={t.id}
                style={{
                  background: "var(--bg-surface)",
                  border: `1px solid ${isExpanded ? "var(--cyan-border)" : "var(--border-subtle)"}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  transition: "border-color 0.2s",
                }}
              >
                {/* Task header */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : t.id)}
                  style={{
                    padding: "14px 18px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--cyan-bg-faint)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  {/* Priority dot */}
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: pc, flexShrink: 0 }} />

                  {/* Title */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--text-primary-alt)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {t.title}
                    </div>
                    {t.assignee && (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        {t.assignee.replace("sentinel:", "")}
                      </div>
                    )}
                  </div>

                  {/* Status badge */}
                  <span style={{
                    background: sc.bg,
                    color: sc.color,
                    padding: "3px 10px",
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "capitalize",
                    flexShrink: 0,
                  }}>
                    {t.status.replace("_", " ")}
                  </span>

                  {/* Time */}
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                    {timeAgo(t.updated_at)}
                  </span>

                  {/* Chevron */}
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
                    style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: "0 18px 18px", borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
                    {/* Description */}
                    {t.description && (
                      <div style={{ fontSize: 13, color: "var(--text-body)", lineHeight: 1.6, marginBottom: 16, whiteSpace: "pre-wrap" }}>
                        {t.description}
                      </div>
                    )}

                    {/* Metadata row */}
                    <div style={{ display: "flex", gap: 20, fontSize: 12, color: "var(--text-muted)", marginBottom: 16, flexWrap: "wrap" }}>
                      <span>Priority: <strong style={{ color: pc, textTransform: "capitalize" }}>{t.priority}</strong></span>
                      <span>Created by: <strong style={{ color: "var(--text-primary-alt)" }}>{t.created_by}</strong></span>
                      {t.assignee && <span>Assignee: <strong style={{ color: "var(--cyan)" }}>{t.assignee}</strong></span>}
                      {t.goal_id && <span>Goal: <strong style={{ color: "var(--text-primary-alt)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{t.goal_id.slice(0, 10)}...</strong></span>}
                      {t.deadline && <span>Deadline: <strong style={{ color: "var(--text-primary-alt)" }}>{new Date(t.deadline).toLocaleDateString()}</strong></span>}
                      <span>Created: {timeAgo(t.created_at)}</span>
                      {t.started_at && <span>Started: {timeAgo(t.started_at)}</span>}
                      {t.completed_at && <span>Completed: {timeAgo(t.completed_at)}</span>}
                    </div>

                    {/* Result */}
                    {t.result && (
                      <div style={{
                        background: t.status === "failed" ? "var(--red-dim)" : "var(--bg-deep)",
                        border: `1px solid ${t.status === "failed" ? "var(--red-border-dim)" : "var(--border-subtle)"}`,
                        borderRadius: 6,
                        padding: "10px 14px",
                        fontSize: 12,
                        color: "var(--text-secondary-alt)",
                        lineHeight: 1.6,
                        marginBottom: 16,
                        whiteSpace: "pre-wrap",
                      }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                          {t.status === "failed" ? "Error" : "Result"}
                        </div>
                        {t.result}
                      </div>
                    )}

                    {/* Dependencies */}
                    {t.dependencies.length > 0 && (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
                        Dependencies: {t.dependencies.map((d) => d.slice(0, 10)).join(", ")}
                      </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => confirmToast("Delete this task?", () => deleteMutation.mutate(t.id))}
                        style={{
                          background: "var(--red-dim)",
                          color: "var(--red)",
                          border: "1px solid var(--red-border-dim)",
                          borderRadius: 6,
                          padding: "5px 14px",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
