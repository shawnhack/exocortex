import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Memory } from "../api/client";
import { useToast } from "../components/Toast";

const FACT_TAG_COLORS: Record<string, { color: string; bg: string }> = {
  decision: { color: "#8b5cf6", bg: "rgba(139, 92, 246, 0.15)" },
  discovery: { color: "#22d3ee", bg: "rgba(34, 211, 238, 0.15)" },
  architecture: { color: "#34d399", bg: "rgba(52, 211, 153, 0.15)" },
  learning: { color: "#fbbf24", bg: "rgba(251, 191, 36, 0.15)" },
};

function wordDiff(oldText: string, newText: string) {
  const oldWords = oldText.split(/\s+/);
  const newWords = newText.split(/\s+/);
  const result: Array<{ text: string; type: "same" | "added" | "removed" }> = [];

  // Simple LCS-based diff
  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i - 1] === newWords[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldWords[i - 1] === newWords[j - 1]) { lcs.unshift(oldWords[i - 1]); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }

  let oi = 0, ni = 0, li = 0;
  while (oi < m || ni < n) {
    if (li < lcs.length && oi < m && ni < n && oldWords[oi] === lcs[li] && newWords[ni] === lcs[li]) {
      result.push({ text: lcs[li], type: "same" });
      oi++; ni++; li++;
    } else {
      if (oi < m && (li >= lcs.length || oldWords[oi] !== lcs[li])) {
        result.push({ text: oldWords[oi], type: "removed" });
        oi++;
      } else if (ni < n && (li >= lcs.length || newWords[ni] !== lcs[li])) {
        result.push({ text: newWords[ni], type: "added" });
        ni++;
      }
    }
  }
  return result;
}

export function MemoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editImportance, setEditImportance] = useState(0.5);
  const [newTag, setNewTag] = useState("");

  const { data: memory, isLoading, error } = useQuery({
    queryKey: ["memory", id],
    queryFn: () => api.getMemory(id!),
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.archiveMemory(id!),
    onSuccess: () => {
      toast("Moved to trash", "success");
      queryClient.invalidateQueries({ queryKey: ["recent"] });
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      navigate("/timeline");
    },
    onError: (err) => {
      toast((err as Error).message, "error");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { content: string; tags: string[]; importance: number }) =>
      api.updateMemory(id!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory", id] });
      setIsEditing(false);
    },
  });

  const startEditing = () => {
    if (!memory) return;
    setEditContent(memory.content);
    setEditTags(memory.tags ?? []);
    setEditImportance(memory.importance);
    setIsEditing(true);
  };

  const handleSave = () => {
    updateMutation.mutate({
      content: editContent,
      tags: editTags,
      importance: editImportance,
    });
  };

  const addTag = () => {
    const tag = newTag.trim();
    if (tag && !editTags.includes(tag)) {
      setEditTags([...editTags, tag]);
    }
    setNewTag("");
  };

  const removeTag = (tag: string) => {
    setEditTags(editTags.filter((t) => t !== tag));
  };

  if (isLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );

  if (error)
    return (
      <p style={{ color: "#f87171", fontSize: 14 }}>
        Error: {(error as Error).message}
      </p>
    );

  if (!memory)
    return <p style={{ color: "#8080a0" }}>Not found.</p>;

  const fmtDate = (s: string) => {
    const normalized = s.includes("T") ? s : s.replace(" ", "T") + "Z";
    return new Date(normalized).toLocaleString();
  };

  const metadataRows: [string, string][] = [
    ["Type", memory.content_type],
    ["Source", memory.source],
    ["Source URI", memory.source_uri ?? "\u2014"],
    ...(memory.metadata?.model ? [["Model", String(memory.metadata.model)] as [string, string]] : []),
    ["Importance", String(memory.importance)],
    ["Access Count", String(memory.access_count)],
    ["Last Accessed", memory.last_accessed_at ? fmtDate(memory.last_accessed_at) : "\u2014"],
    ["Active", memory.is_active ? "Yes" : "No"],
    ["Created", fmtDate(memory.created_at)],
    ["Updated", fmtDate(memory.updated_at)],
  ];

  const importanceColor = editImportance >= 0.8 ? "#f472b6" : editImportance >= 0.5 ? "#8b5cf6" : editImportance >= 0.3 ? "#22d3ee" : "#8080a0";

  return (
    <div>
      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        style={{
          background: "none",
          border: "none",
          color: "#8080a0",
          cursor: "pointer",
          padding: 0,
          marginBottom: 20,
          fontSize: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "#8b5cf6"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "#8080a0"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      {/* ID */}
      <h1
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 15,
          color: "#22d3ee",
          fontWeight: 500,
          marginBottom: 20,
          animation: "slideUp 0.3s ease-out both",
        }}
      >
        {memory.id}
      </h1>

      {/* Content card */}
      <div
        style={{
          background: "#0c0c1d",
          border: `1px solid ${isEditing ? "rgba(139, 92, 246, 0.3)" : "#16163a"}`,
          borderRadius: 12,
          padding: 24,
          marginBottom: 24,
          position: "relative",
          transition: "border-color 0.3s",
          animation: "slideUp 0.3s ease-out 0.04s both",
        }}
      >
        {!isEditing && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <button
              data-testid="memory-edit-button"
              onClick={startEditing}
              style={{
                background: "rgba(139, 92, 246, 0.15)",
                color: "#8b5cf6",
                border: "1px solid rgba(139, 92, 246, 0.3)",
                borderRadius: 6,
                padding: "5px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(139, 92, 246, 0.25)";
                e.currentTarget.style.boxShadow = "0 0 12px rgba(139, 92, 246, 0.15)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(139, 92, 246, 0.15)";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          </div>
        )}

        {isEditing ? (
          <div>
            {/* Edit mode header */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6, marginBottom: 12,
              fontSize: 11, color: "#8b5cf6", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Editing
            </div>

            <textarea
              data-testid="memory-edit-textarea"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              style={{
                width: "100%",
                minHeight: 200,
                background: "#06060e",
                border: "1px solid #16163a",
                borderRadius: 8,
                color: "#d0d0e0",
                padding: 14,
                fontSize: 14,
                lineHeight: 1.7,
                fontFamily: "inherit",
                resize: "vertical",
                transition: "border-color 0.2s, box-shadow 0.2s",
                outline: "none",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "#8b5cf6";
                e.currentTarget.style.boxShadow = "0 0 0 3px rgba(139, 92, 246, 0.12)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "#16163a";
                e.currentTarget.style.boxShadow = "none";
              }}
            />

            {/* Editable tags */}
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 8, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
                Tags
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {editTags.map((tag) => {
                  const factColor = FACT_TAG_COLORS[tag];
                  return (
                    <span
                      key={tag}
                      style={{
                        background: factColor?.bg ?? "rgba(139, 92, 246, 0.15)",
                        color: factColor?.color ?? "#8b5cf6",
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
                      <span
                        onClick={() => removeTag(tag)}
                        style={{
                          cursor: "pointer",
                          opacity: 0.7,
                          fontSize: 14,
                          lineHeight: 1,
                          transition: "opacity 0.15s",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.7"; }}
                      >
                        &times;
                      </span>
                    </span>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  data-testid="memory-edit-tag-input"
                  type="text"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                  placeholder="Add tag..."
                  style={{
                    background: "#06060e",
                    border: "1px solid #16163a",
                    borderRadius: 6,
                    color: "#d0d0e0",
                    padding: "5px 12px",
                    fontSize: 12,
                    flex: 1,
                    maxWidth: 200,
                    outline: "none",
                    transition: "border-color 0.2s",
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "#8b5cf6"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "#16163a"; }}
                />
                <button
                  onClick={addTag}
                  style={{
                    background: "rgba(139, 92, 246, 0.15)",
                    color: "#8b5cf6",
                    border: "1px solid rgba(139, 92, 246, 0.3)",
                    borderRadius: 6,
                    padding: "5px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(139, 92, 246, 0.25)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(139, 92, 246, 0.15)"; }}
                >
                  Add
                </button>
              </div>
            </div>

            {/* Importance with visual bar */}
            <div style={{ marginTop: 20 }}>
              <div style={{
                fontSize: 11, color: "#8080a0", marginBottom: 8, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em",
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span>Importance</span>
                <span style={{
                  color: importanceColor,
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  fontWeight: 700,
                }}>
                  {editImportance.toFixed(1)}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={editImportance}
                  onChange={(e) => setEditImportance(Number(e.target.value))}
                  style={{
                    flex: 1,
                    height: 4,
                    appearance: "none",
                    WebkitAppearance: "none",
                    background: `linear-gradient(90deg, ${importanceColor} ${editImportance * 100}%, #16163a ${editImportance * 100}%)`,
                    borderRadius: 2,
                    outline: "none",
                    cursor: "pointer",
                  }}
                />
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={editImportance}
                  onChange={(e) => setEditImportance(Number(e.target.value))}
                  style={{
                    background: "#06060e",
                    border: "1px solid #16163a",
                    borderRadius: 6,
                    color: importanceColor,
                    padding: "4px 8px",
                    fontSize: 13,
                    width: 64,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    textAlign: "center",
                    outline: "none",
                  }}
                />
              </div>
            </div>

            {/* Save / Cancel */}
            <div style={{ display: "flex", gap: 8, marginTop: 20, alignItems: "center" }}>
              <button
                data-testid="memory-edit-save"
                onClick={handleSave}
                disabled={updateMutation.isPending}
                style={{
                  background: "#8b5cf6",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 20px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: updateMutation.isPending ? 0.6 : 1,
                  transition: "all 0.15s",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
                onMouseEnter={(e) => { if (!updateMutation.isPending) e.currentTarget.style.boxShadow = "0 0 20px rgba(139, 92, 246, 0.3)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                {updateMutation.isPending ? "Saving..." : "Save"}
              </button>
              <button
                data-testid="memory-edit-cancel"
                onClick={() => setIsEditing(false)}
                style={{
                  background: "transparent",
                  color: "#8080a0",
                  border: "1px solid #16163a",
                  borderRadius: 8,
                  padding: "8px 20px",
                  fontSize: 13,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#8080a0"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#16163a"; }}
              >
                Cancel
              </button>
              {updateMutation.isError && (
                <span style={{ color: "#f87171", fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  {(updateMutation.error as Error).message}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div
            data-testid="memory-content"
            style={{
              whiteSpace: "pre-wrap",
              lineHeight: 1.7,
              color: "#d0d0e0",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            {memory.content}
          </div>
        )}
      </div>

      {/* Tags (view mode) */}
      {!isEditing && memory.tags && memory.tags.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 24, animation: "slideUp 0.3s ease-out 0.08s both" }}>
          {memory.tags.map((tag) => {
            const factColor = FACT_TAG_COLORS[tag];
            return (
              <span
                key={tag}
                onClick={() => navigate(`/?tag=${encodeURIComponent(tag)}`)}
                style={{
                  background: factColor?.bg ?? "rgba(139, 92, 246, 0.15)",
                  color: factColor?.color ?? "#8b5cf6",
                  padding: "4px 14px",
                  borderRadius: 20,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
              >
                {tag}
              </span>
            );
          })}
        </div>
      )}

      {/* Metadata grid */}
      <div
        style={{
          background: "#0c0c1d",
          border: "1px solid #16163a",
          borderRadius: 12,
          padding: 20,
          marginBottom: 32,
          animation: "slideUp 0.3s ease-out 0.12s both",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px 32px",
          }}
        >
          {metadataRows.map(([label, value]) => (
            <div key={label}>
              <div
                style={{
                  fontSize: 11,
                  color: "#8080a0",
                  marginBottom: 2,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontWeight: 600,
                }}
              >
                {label}
              </div>
              <div
                data-testid="memory-metadata-value"
                style={{
                  fontSize: 13,
                  color: "#e8e8f4",
                  fontFamily: "var(--font-mono)",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Custom metadata */}
      {memory.metadata && Object.keys(memory.metadata).length > 0 && (
        <div
          style={{
            background: "#0c0c1d",
            border: "1px solid #16163a",
            borderRadius: 12,
            padding: 20,
            marginBottom: 24,
            animation: "slideUp 0.3s ease-out 0.13s both",
          }}
        >
          <div style={{
            fontSize: 11, color: "#8080a0", marginBottom: 12, textTransform: "uppercase",
            fontWeight: 600, letterSpacing: "0.05em",
          }}>
            Metadata
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 32px" }}>
            {Object.entries(memory.metadata).map(([key, value]) => (
              <div key={key}>
                <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 2 }}>{key}</div>
                <div
                  data-testid="memory-metadata-value"
                  style={{
                    fontSize: 13,
                    color: "#e8e8f4",
                    fontFamily: "var(--font-mono)",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {typeof value === "object" ? JSON.stringify(value) : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Linked Memories */}
      <LinkedMemories memoryId={memory.id} />

      {/* Supersession diff view */}
      <SupersessionView memory={memory} />

      {/* Danger zone */}
      <div
        style={{
          background: "rgba(248, 113, 113, 0.05)",
          border: "1px solid rgba(248, 113, 113, 0.15)",
          borderRadius: 12,
          padding: 20,
          animation: "slideUp 0.3s ease-out 0.16s both",
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#f87171",
            marginBottom: 10,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Danger Zone
        </div>
        <button
          className="btn-danger"
          onClick={() => {
            confirmToast("Move this memory to trash?", () => deleteMutation.mutate());
          }}
        >
          Delete Memory
        </button>
        {deleteMutation.isError && (
          <span style={{ marginLeft: 12, color: "#f87171", fontSize: 13 }}>
            {(deleteMutation.error as Error).message}
          </span>
        )}
      </div>
    </div>
  );
}

const LINK_TYPE_COLORS: Record<string, string> = {
  related: "#8b5cf6",
  elaborates: "#22d3ee",
  contradicts: "#f87171",
  supersedes: "#fbbf24",
  supports: "#34d399",
  derived_from: "#f472b6",
};

function LinkedMemories({ memoryId }: { memoryId: string }) {
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ["memory-links", memoryId],
    queryFn: () => api.getMemoryLinks(memoryId),
    enabled: !!memoryId,
  });

  if (!data || data.count === 0) return null;

  return (
    <div
      style={{
        background: "#0c0c1d",
        border: "1px solid #16163a",
        borderRadius: 12,
        padding: 20,
        marginBottom: 24,
        animation: "slideUp 0.3s ease-out 0.10s both",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "#8b5cf6",
          marginBottom: 14,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        Linked Memories ({data.count})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.links.map((link) => (
          <div
            key={link.memory_id}
            onClick={() => navigate(`/memory/${link.memory_id}`)}
            style={{
              background: "#06060e",
              border: "1px solid #16163a",
              borderRadius: 8,
              padding: "10px 14px",
              cursor: "pointer",
              transition: "all 0.15s",
              borderLeft: `3px solid ${LINK_TYPE_COLORS[link.link_type] ?? "#8b5cf6"}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#0a0a18";
              e.currentTarget.style.boxShadow = "0 0 8px rgba(139, 92, 246, 0.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#06060e";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: LINK_TYPE_COLORS[link.link_type] ?? "#8b5cf6",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {link.link_type}
              </span>
              <span style={{ fontSize: 10, color: "#8080a0" }}>
                strength: {link.strength.toFixed(2)}
              </span>
            </div>
            {link.preview && (
              <div style={{ fontSize: 13, color: "#a0a0be", lineHeight: 1.5 }}>
                {link.preview.content}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SupersessionView({ memory }: { memory: Memory }) {
  // Check if this memory was superseded by another
  const { data: supersededBy, isLoading } = useQuery({
    queryKey: ["memory", memory.superseded_by],
    queryFn: () => api.getMemory(memory.superseded_by!),
    enabled: !!memory.superseded_by,
  });

  // Check if this memory supersedes another (look for memories that have superseded_by = this id)
  // We just show what we know from the current memory's data

  if (!memory.superseded_by) return null;
  if (isLoading) return (
    <div
      style={{
        background: "#0c0c1d",
        border: "1px solid #16163a",
        borderRadius: 12,
        padding: 20,
        marginBottom: 24,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div className="spinner" />
      <span style={{ color: "#8080a0", fontSize: 13 }}>Loading supersession data...</span>
    </div>
  );
  if (!supersededBy) return null;

  return (
    <div
      style={{
        background: "#0c0c1d",
        border: "1px solid #16163a",
        borderRadius: 12,
        padding: 20,
        marginBottom: 24,
        animation: "slideUp 0.3s ease-out 0.14s both",
      }}
    >
      {supersededBy && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#fbbf24", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
            </svg>
            Superseded By
          </div>
          <Link
            to={`/memory/${supersededBy.id}`}
            style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "#22d3ee", display: "block", marginBottom: 12 }}
          >
            {supersededBy.id}
          </Link>

          {/* Word diff */}
          <div style={{
            background: "#06060e",
            borderRadius: 8,
            padding: 14,
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            maxHeight: 300,
            overflowY: "auto",
          }}>
            {wordDiff(memory.content, supersededBy.content).map((part, i) => (
              <span
                key={i}
                style={{
                  background: part.type === "added" ? "rgba(74, 222, 128, 0.15)" : part.type === "removed" ? "rgba(248, 113, 113, 0.15)" : "transparent",
                  color: part.type === "added" ? "#4ade80" : part.type === "removed" ? "#f87171" : "#d0d0e0",
                  textDecoration: part.type === "removed" ? "line-through" : "none",
                }}
              >
                {part.text}{" "}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
