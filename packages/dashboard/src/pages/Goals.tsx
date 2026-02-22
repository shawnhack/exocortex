import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Goal } from "../api/client";
import { useToast } from "../components/Toast";

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  active: { color: "#34d399", bg: "rgba(52, 211, 153, 0.15)" },
  completed: { color: "#38bdf8", bg: "rgba(56, 189, 248, 0.15)" },
  stalled: { color: "#fbbf24", bg: "rgba(251, 191, 36, 0.15)" },
  abandoned: { color: "#8080a0", bg: "rgba(128, 128, 160, 0.1)" },
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#f87171",
  high: "#f472b6",
  medium: "#fbbf24",
  low: "#8080a0",
};

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z");
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function Goals() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPriority, setNewPriority] = useState("medium");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["goals", statusFilter],
    queryFn: () => api.getGoals(statusFilter),
  });

  const { data: expandedGoal, isLoading: expandedLoading } = useQuery({
    queryKey: ["goal", expandedId],
    queryFn: () => api.getGoal(expandedId!),
    enabled: !!expandedId,
  });

  const createMutation = useMutation({
    mutationFn: () => api.createGoal({ title: newTitle, description: newDesc || undefined, priority: newPriority }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      setShowCreate(false);
      setNewTitle("");
      setNewDesc("");
      setNewPriority("medium");
      toast("Goal created", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Goal> }) => api.updateGoal(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      queryClient.invalidateQueries({ queryKey: ["goal"] });
      toast("Goal updated", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteGoal(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      setExpandedId(null);
      toast("Goal deleted", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const statuses = ["all", "active", "stalled", "completed", "abandoned"];

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading goals...</span>
      </div>
    );
  }

  const goals = data?.goals ?? [];

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "#e8e8f4", marginBottom: 4 }}>Goals</h1>
          <p style={{ fontSize: 13, color: "#8080a0", margin: 0 }}>Track objectives, milestones, and progress</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            background: "rgba(34, 211, 238, 0.15)",
            color: "#22d3ee",
            border: "1px solid rgba(34, 211, 238, 0.3)",
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(34, 211, 238, 0.25)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(34, 211, 238, 0.15)"; }}
        >
          + New Goal
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div
          style={{
            background: "#0c0c1d",
            border: "1px solid rgba(34, 211, 238, 0.3)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
            animation: "slideUp 0.2s ease-out both",
          }}
        >
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Goal title..."
            style={{
              width: "100%",
              background: "#06060e",
              border: "1px solid #16163a",
              borderRadius: 8,
              color: "#e8e8f4",
              padding: "10px 14px",
              fontSize: 14,
              marginBottom: 10,
              outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "#22d3ee"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "#16163a"; }}
          />
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)..."
            rows={3}
            style={{
              width: "100%",
              background: "#06060e",
              border: "1px solid #16163a",
              borderRadius: 8,
              color: "#d0d0e0",
              padding: "10px 14px",
              fontSize: 13,
              marginBottom: 10,
              resize: "vertical",
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
              style={{
                background: "#06060e",
                border: "1px solid #16163a",
                borderRadius: 6,
                color: "#d0d0e0",
                padding: "6px 10px",
                fontSize: 12,
                outline: "none",
              }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <button
              onClick={() => createMutation.mutate()}
              disabled={!newTitle.trim() || createMutation.isPending}
              style={{
                background: "#22d3ee",
                color: "#000",
                border: "none",
                borderRadius: 6,
                padding: "7px 18px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                opacity: !newTitle.trim() || createMutation.isPending ? 0.5 : 1,
              }}
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              style={{ background: "none", border: "none", color: "#8080a0", cursor: "pointer", fontSize: 13 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Status filter tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              background: statusFilter === s ? "rgba(34, 211, 238, 0.15)" : "transparent",
              color: statusFilter === s ? "#22d3ee" : "#8080a0",
              border: "1px solid " + (statusFilter === s ? "rgba(34, 211, 238, 0.3)" : "transparent"),
              borderRadius: 20,
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              textTransform: "capitalize",
              transition: "all 0.15s",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Goals list */}
      {goals.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#8080a0" }}>
          No goals found. Create one to get started.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {goals.map((goal) => {
            const sc = STATUS_COLORS[goal.status] ?? STATUS_COLORS.active;
            const pc = PRIORITY_COLORS[goal.priority] ?? "#8080a0";
            const isExpanded = expandedId === goal.id;
            const milestones = isExpanded && expandedGoal ? expandedGoal.milestones : [];
            const progress = isExpanded && expandedGoal ? expandedGoal.progress : [];
            const milestonesDone = milestones.filter((m) => m.status === "completed").length;

            return (
              <div
                key={goal.id}
                style={{
                  background: "#0c0c1d",
                  border: `1px solid ${isExpanded ? "rgba(34, 211, 238, 0.3)" : "#16163a"}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  transition: "border-color 0.2s",
                }}
              >
                {/* Goal header */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : goal.id)}
                  style={{
                    padding: "14px 18px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(34, 211, 238, 0.03)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  {/* Priority dot */}
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: pc, flexShrink: 0 }} />

                  {/* Title */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#e8e8f4",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {goal.title}
                    </div>
                    {goal.description && (
                      <div style={{ fontSize: 12, color: "#8080a0", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {goal.description}
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
                    {goal.status}
                  </span>

                  {/* Time */}
                  <span style={{ fontSize: 11, color: "#8080a0", flexShrink: 0 }}>
                    {timeAgo(goal.updated_at)}
                  </span>

                  {/* Chevron */}
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8080a0" strokeWidth="2"
                    style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: "0 18px 18px", borderTop: "1px solid #16163a", paddingTop: 14 }}>
                    {/* Loading state for expanded detail */}
                    {expandedLoading && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <div className="spinner" style={{ width: 14, height: 14 }} />
                        <span style={{ color: "#8080a0", fontSize: 12 }}>Loading details...</span>
                      </div>
                    )}

                    {/* Description */}
                    {goal.description && (
                      <div style={{ fontSize: 13, color: "#d0d0e0", lineHeight: 1.6, marginBottom: 16, whiteSpace: "pre-wrap" }}>
                        {goal.description}
                      </div>
                    )}

                    {/* Metadata row */}
                    <div style={{ display: "flex", gap: 20, fontSize: 12, color: "#8080a0", marginBottom: 16, flexWrap: "wrap" }}>
                      <span>Priority: <strong style={{ color: pc, textTransform: "capitalize" }}>{goal.priority}</strong></span>
                      {goal.deadline && <span>Deadline: <strong style={{ color: "#e8e8f4" }}>{new Date(goal.deadline).toLocaleDateString()}</strong></span>}
                      <span>Created: {timeAgo(goal.created_at)}</span>
                      {goal.completed_at && <span>Completed: {timeAgo(goal.completed_at)}</span>}
                    </div>

                    {/* Milestones */}
                    {milestones.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#8080a0", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                          Milestones ({milestonesDone}/{milestones.length})
                        </div>
                        {/* Progress bar */}
                        <div style={{ height: 4, background: "#16163a", borderRadius: 2, marginBottom: 10 }}>
                          <div style={{
                            height: "100%",
                            width: `${milestones.length > 0 ? (milestonesDone / milestones.length) * 100 : 0}%`,
                            background: "linear-gradient(90deg, #06b6d4, #22d3ee)",
                            borderRadius: 2,
                            transition: "width 0.3s",
                          }} />
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {milestones.map((m) => (
                            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                              <div style={{
                                width: 16, height: 16, borderRadius: 4, border: "1px solid #16163a",
                                background: m.status === "completed" ? "#22d3ee" : "transparent",
                                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                              }}>
                                {m.status === "completed" && (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
                                )}
                              </div>
                              <span style={{ color: m.status === "completed" ? "#8080a0" : "#d0d0e0", textDecoration: m.status === "completed" ? "line-through" : "none" }}>
                                {m.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recent progress */}
                    {progress.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#8080a0", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                          Recent Progress
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {progress.slice(0, 5).map((p) => (
                            <div
                              key={p.id}
                              onClick={() => navigate(`/memory/${p.id}`)}
                              style={{
                                background: "#06060e",
                                border: "1px solid #16163a",
                                borderRadius: 6,
                                padding: "8px 12px",
                                fontSize: 12,
                                color: "#a0a0be",
                                lineHeight: 1.5,
                                cursor: "pointer",
                                transition: "border-color 0.15s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(34, 211, 238, 0.3)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#16163a"; }}
                            >
                              <span style={{ color: "#8080a0", marginRight: 8 }}>{timeAgo(p.created_at)}</span>
                              {p.content.length > 150 ? p.content.slice(0, 150) + "..." : p.content}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {goal.status === "active" && (
                        <>
                          <button
                            onClick={() => updateMutation.mutate({ id: goal.id, data: { status: "completed" } })}
                            style={{
                              background: "rgba(52, 211, 153, 0.15)",
                              color: "#34d399",
                              border: "1px solid rgba(52, 211, 153, 0.3)",
                              borderRadius: 6,
                              padding: "5px 14px",
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Complete
                          </button>
                          <button
                            onClick={() => updateMutation.mutate({ id: goal.id, data: { status: "stalled" } })}
                            style={{
                              background: "rgba(251, 191, 36, 0.1)",
                              color: "#fbbf24",
                              border: "1px solid rgba(251, 191, 36, 0.2)",
                              borderRadius: 6,
                              padding: "5px 14px",
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Mark Stalled
                          </button>
                        </>
                      )}
                      {goal.status === "stalled" && (
                        <button
                          onClick={() => updateMutation.mutate({ id: goal.id, data: { status: "active" } })}
                          style={{
                            background: "rgba(52, 211, 153, 0.15)",
                            color: "#34d399",
                            border: "1px solid rgba(52, 211, 153, 0.3)",
                            borderRadius: 6,
                            padding: "5px 14px",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Reactivate
                        </button>
                      )}
                      <button
                        onClick={() => confirmToast("Delete this goal?", () => deleteMutation.mutate(goal.id))}
                        style={{
                          background: "rgba(248, 113, 113, 0.1)",
                          color: "#f87171",
                          border: "1px solid rgba(248, 113, 113, 0.2)",
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
