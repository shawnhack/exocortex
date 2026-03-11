import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type LibraryDocument, type LibraryDocumentDetail, type ResearchResult } from "../api/client";
import { useToast } from "../components/Toast";
import { TIER_BADGE_COLORS } from "../constants/colors";
import { timeAgo } from "../utils/format";

function formatChars(chars: number): string {
  if (chars >= 1000000) return `${(chars / 1000000).toFixed(1)}M`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k`;
  return String(chars);
}

const STATUS_ICONS: Record<string, { color: string; label: string }> = {
  ingested: { color: "var(--emerald)", label: "OK" },
  failed: { color: "var(--red-strong)", label: "FAIL" },
  skipped: { color: "var(--amber)", label: "SKIP" },
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-panel)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 8,
  padding: "10px 14px",
  color: "var(--text-primary-alt)",
  fontSize: 14,
  outline: "none",
};

export function Library() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [activePanel, setActivePanel] = useState<"none" | "ingest" | "research">("none");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [researchTopic, setResearchTopic] = useState("");
  const [researchMaxSources, setResearchMaxSources] = useState("5");
  const [researchTags, setResearchTags] = useState("");
  const [lastResearch, setLastResearch] = useState<ResearchResult | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ["library-documents", debouncedSearch],
    queryFn: () => api.getLibraryDocuments(50, 0, debouncedSearch || undefined),
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["library-document", expandedId],
    queryFn: () => api.getLibraryDocument(expandedId!),
    enabled: !!expandedId,
  });

  const ingestMutation = useMutation({
    mutationFn: () =>
      api.ingestUrl({
        url: url.trim(),
        title: title.trim() || undefined,
        tags: tags.trim() ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["library-documents"] });
      setActivePanel("none");
      setUrl("");
      setTitle("");
      setTags("");
      toast(`Ingested "${result.title}" (${result.chunks_stored} chunks)`, "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const researchMutation = useMutation({
    mutationFn: () =>
      api.researchTopic({
        topic: researchTopic.trim(),
        max_sources: parseInt(researchMaxSources, 10) || 5,
        tags: researchTags.trim() ? researchTags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["library-documents"] });
      setLastResearch(result);
      toast(
        `Research complete: ${result.sources_ingested} sources ingested (${result.total_chunks} chunks)`,
        "success"
      );
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library-documents"] });
      setExpandedId(null);
      toast("Document deleted", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const documents = data?.documents ?? [];
  const totalChars = documents.reduce((sum, d) => sum + d.total_chars, 0);
  const totalChunks = documents.reduce((sum, d) => sum + d.chunk_count, 0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ color: "var(--text-primary-alt)", fontSize: 22, fontWeight: 600, margin: 0 }}>Library</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "4px 0 0" }}>
            {documents.length} documents, {formatChars(totalChars)} chars, {totalChunks} chunks
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setActivePanel(activePanel === "research" ? "none" : "research")}
            style={{
              background: activePanel === "research"
                ? "linear-gradient(135deg, var(--purple-bg-active), var(--purple-border-faint))"
                : "linear-gradient(135deg, var(--purple-bg), var(--purple-bg-subtle))",
              border: activePanel === "research"
                ? "1px solid var(--purple-border-strong)"
                : "1px solid var(--purple-border)",
              color: "var(--purple)",
              padding: "8px 16px",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Research Topic
          </button>
          <button
            onClick={() => setActivePanel(activePanel === "ingest" ? "none" : "ingest")}
            style={{
              background: activePanel === "ingest"
                ? "linear-gradient(135deg, var(--cyan-border-dim), var(--cyan-bg-active))"
                : "linear-gradient(135deg, var(--violet-dim), var(--cyan-bg-subtle))",
              border: activePanel === "ingest"
                ? "1px solid var(--cyan-border-strong)"
                : "1px solid var(--cyan-border-dim)",
              color: "var(--cyan)",
              padding: "8px 16px",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Ingest URL
          </button>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 20 }}>
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
          style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="Search documents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            ...inputStyle,
            width: "100%",
            paddingLeft: 40,
          }}
          onFocus={(e) => (e.target.style.borderColor = "var(--cyan-border-strong)")}
          onBlur={(e) => (e.target.style.borderColor = "var(--border-subtle)")}
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            style={{
              position: "absolute",
              right: 12,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 16,
              padding: 4,
            }}
          >
            &times;
          </button>
        )}
      </div>

      {/* Research Form */}
      {activePanel === "research" && (
        <div
          style={{
            background: "var(--bg-overlay-medium)",
            border: "1px solid var(--purple-border)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ color: "var(--text-primary-alt)", fontSize: 15, fontWeight: 600, margin: 0 }}>Research a Topic</h3>
            <button
              onClick={() => { setActivePanel("none"); setLastResearch(null); }}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}
            >
              x
            </button>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 14px", lineHeight: 1.5 }}>
            Searches the web, finds relevant sources, and ingests the best results into your library.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              type="text"
              placeholder="e.g. crypto trading strategies, TypeScript design patterns, machine learning fundamentals"
              value={researchTopic}
              onChange={(e) => setResearchTopic(e.target.value)}
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter" && researchTopic.trim() && !researchMutation.isPending) {
                  researchMutation.mutate();
                }
              }}
              onFocus={(e) => (e.target.style.borderColor = "var(--purple-border-strong)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border-subtle)")}
            />
            <div style={{ display: "flex", gap: 12 }}>
              <input
                type="text"
                placeholder="Tags (comma-separated)"
                value={researchTags}
                onChange={(e) => setResearchTags(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
                onFocus={(e) => (e.target.style.borderColor = "var(--purple-border-strong)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border-subtle)")}
              />
              <select
                value={researchMaxSources}
                onChange={(e) => setResearchMaxSources(e.target.value)}
                style={{
                  ...inputStyle,
                  width: 140,
                  cursor: "pointer",
                  appearance: "auto" as React.CSSProperties["appearance"],
                }}
              >
                <option value="3">3 sources</option>
                <option value="5">5 sources</option>
                <option value="10">10 sources</option>
                <option value="15">15 sources</option>
                <option value="20">20 sources</option>
              </select>
            </div>
            <button
              onClick={() => researchMutation.mutate()}
              disabled={!researchTopic.trim() || researchMutation.isPending}
              style={{
                background: !researchTopic.trim()
                  ? "var(--bg-panel-dim)"
                  : "linear-gradient(135deg, var(--purple), var(--purple-dark))",
                border: "none",
                color: !researchTopic.trim() ? "var(--text-muted)" : "white",
                padding: "10px 20px",
                borderRadius: 8,
                cursor: !researchTopic.trim() ? "not-allowed" : "pointer",
                fontSize: 14,
                fontWeight: 600,
                alignSelf: "flex-end",
              }}
            >
              {researchMutation.isPending ? "Researching..." : "Research"}
            </button>
          </div>

          {/* Research Results */}
          {researchMutation.isPending && (
            <div style={{ marginTop: 16, padding: 16, background: "var(--purple-bg-faint)", borderRadius: 8, border: "1px solid var(--purple-border-faint)" }}>
              <p style={{ color: "var(--purple)", fontSize: 13, margin: 0 }}>
                Searching the web and ingesting sources... This may take a minute.
              </p>
            </div>
          )}

          {lastResearch && !researchMutation.isPending && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                <Stat label="Found" value={lastResearch.sources_found} />
                <Stat label="Ingested" value={lastResearch.sources_ingested} color="var(--emerald)" />
                <Stat label="Failed" value={lastResearch.sources_failed} color="var(--red-strong)" />
                <Stat label="Skipped" value={lastResearch.sources_skipped} color="var(--amber)" />
                <Stat label="Chunks" value={lastResearch.total_chunks} />
                <Stat label="Chars" value={formatChars(lastResearch.total_chars)} />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim-alt)", marginBottom: 10 }}>
                Queries: {lastResearch.queries_run.join(" | ")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {lastResearch.sources.map((s, i) => {
                  const st = STATUS_ICONS[s.status];
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        background: "var(--bg-overlay-faint)",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    >
                      <span style={{ color: st.color, fontWeight: 600, fontSize: 10, width: 32 }}>
                        [{st.label}]
                      </span>
                      <span style={{ color: "var(--text-primary-alt)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.title}
                      </span>
                      {s.chunks_stored != null && (
                        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                          {s.chunks_stored} chunks
                        </span>
                      )}
                      {s.error && s.status !== "skipped" && (
                        <span style={{ color: "var(--red-strong)", fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.error}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ingest Form */}
      {activePanel === "ingest" && (
        <div
          style={{
            background: "var(--bg-overlay-medium)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ color: "var(--text-primary-alt)", fontSize: 15, fontWeight: 600, margin: 0 }}>Ingest from URL</h3>
            <button
              onClick={() => setActivePanel("none")}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}
            >
              x
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              type="url"
              placeholder="https://example.com/article"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = "var(--cyan-border-strong)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border-subtle)")}
            />
            <div style={{ display: "flex", gap: 12 }}>
              <input
                type="text"
                placeholder="Title (optional, auto-extracted)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
                onFocus={(e) => (e.target.style.borderColor = "var(--cyan-border-strong)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border-subtle)")}
              />
              <input
                type="text"
                placeholder="Tags (comma-separated)"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
                onFocus={(e) => (e.target.style.borderColor = "var(--cyan-border-strong)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border-subtle)")}
              />
            </div>
            <button
              onClick={() => ingestMutation.mutate()}
              disabled={!url.trim() || ingestMutation.isPending}
              style={{
                background: !url.trim() ? "var(--bg-panel-dim)" : "linear-gradient(135deg, var(--cyan), var(--cyan-dark))",
                border: "none",
                color: !url.trim() ? "var(--text-muted)" : "var(--bg-deep-alt)",
                padding: "10px 20px",
                borderRadius: 8,
                cursor: !url.trim() ? "not-allowed" : "pointer",
                fontSize: 14,
                fontWeight: 600,
                alignSelf: "flex-end",
              }}
            >
              {ingestMutation.isPending ? "Ingesting..." : "Ingest"}
            </button>
          </div>
        </div>
      )}

      {/* Document List */}
      {isLoading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading...</p>
      ) : documents.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "var(--text-muted)",
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, marginBottom: 16 }}>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <p style={{ fontSize: 15, margin: "0 0 8px" }}>No documents yet</p>
          <p style={{ fontSize: 13 }}>
            Use <strong style={{ color: "var(--purple)" }}>Research Topic</strong> to auto-discover sources, or <strong style={{ color: "var(--cyan)" }}>Ingest URL</strong> for specific pages.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              isExpanded={expandedId === doc.id}
              detail={expandedId === doc.id ? detail : undefined}
              detailLoading={expandedId === doc.id && detailLoading}
              onToggle={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
              onDelete={() => {
                confirmToast(
                  `Delete "${doc.title}" and ${doc.chunk_count} chunks?`,
                  () => deleteMutation.mutate(doc.id)
                );
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ color: color ?? "var(--text-primary-alt)", fontSize: 16, fontWeight: 600 }}>{value}</span>
      <span style={{ color: "var(--text-dim-alt)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
    </div>
  );
}

function DocumentCard({
  doc,
  isExpanded,
  detail,
  detailLoading,
  onToggle,
  onDelete,
}: {
  doc: LibraryDocument;
  isExpanded: boolean;
  detail?: LibraryDocumentDetail;
  detailLoading: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const tierStyle = TIER_BADGE_COLORS[doc.tier] ?? TIER_BADGE_COLORS.reference;

  return (
    <div
      style={{
        background: isExpanded ? "var(--bg-panel-active)" : "var(--bg-overlay-faint)",
        border: isExpanded ? "1px solid var(--cyan-border-dim)" : "1px solid var(--border-subtle)",
        borderRadius: 10,
        overflow: "hidden",
        transition: "all 0.2s",
      }}
    >
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          padding: "14px 18px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        {/* Icon */}
        <div style={{ flexShrink: 0, color: "var(--text-muted)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>

        {/* Title + URL */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--text-primary-alt)", fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {doc.title}
          </div>
          <div style={{ color: "var(--text-dim-alt)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
            {doc.url}
          </div>
        </div>

        {/* Meta */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {doc.tags.filter(t => t !== "document").length > 0 && (
            <div style={{ display: "flex", gap: 4 }}>
              {doc.tags.filter(t => t !== "document").slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  style={{
                    background: "var(--cyan-bg-tag)",
                    color: "var(--cyan-light)",
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <span
            style={{
              background: tierStyle.bg,
              color: tierStyle.color,
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 4,
              fontWeight: 500,
            }}
          >
            {doc.tier}
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
            {doc.chunk_count} chunks
          </span>
          <span style={{ color: "var(--text-dim-alt)", fontSize: 12, whiteSpace: "nowrap" }}>
            {formatChars(doc.total_chars)}
          </span>
          <span style={{ color: "var(--text-dim-alt)", fontSize: 12, whiteSpace: "nowrap" }}>
            {timeAgo(doc.ingested_at)}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="2"
            style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {/* Expanded Detail */}
      {isExpanded && (
        <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "16px 18px" }}>
          {detailLoading ? (
            <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading chunks...</p>
          ) : detail ? (
            <div>
              {doc.description && (
                <p style={{ color: "var(--text-secondary-alt)", fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
                  {doc.description}
                </p>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    background: "var(--cyan-bg-tag)",
                    border: "1px solid var(--cyan-border-dim)",
                    color: "var(--cyan)",
                    padding: "6px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  Open Source
                </a>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  style={{
                    background: "rgba(239, 68, 68, 0.08)",
                    border: "1px solid rgba(239, 68, 68, 0.2)",
                    color: "var(--red-strong)",
                    padding: "6px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Delete
                </button>
              </div>

              {/* Chunks */}
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, fontWeight: 500 }}>
                {detail.chunks.length} chunks ({formatChars(detail.total_chars)} chars total)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 400, overflowY: "auto" }}>
                {detail.chunks.map((chunk) => (
                  <div
                    key={chunk.id}
                    style={{
                      background: "var(--bg-overlay-light)",
                      border: "1px solid rgba(22, 22, 58, 0.5)",
                      borderRadius: 6,
                      padding: "10px 14px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ color: "var(--text-dim-alt)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                        Chunk {chunk.index + 1}
                      </span>
                      <span style={{ color: "var(--text-dim-alt)", fontSize: 11 }}>
                        {chunk.chars} chars
                      </span>
                    </div>
                    <div
                      style={{
                        color: "var(--text-secondary-alt)",
                        fontSize: 13,
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                        overflow: "hidden",
                        maxHeight: 120,
                        maskImage: "linear-gradient(to bottom, black 80%, transparent 100%)",
                        WebkitMaskImage: "linear-gradient(to bottom, black 80%, transparent 100%)",
                      }}
                    >
                      {chunk.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
