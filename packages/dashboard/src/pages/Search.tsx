import { useState, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type SearchResult } from "../api/client";
import { SearchBar } from "../components/SearchBar";
import { MemoryCard } from "../components/MemoryCard";
import { useToast } from "../components/Toast";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

export function Search() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const searchBarRef = useRef<HTMLInputElement>(null);
  const limit = 20;

  // Filter state
  const filterContentType = searchParams.get("content_type") || "";
  const filterAfter = searchParams.get("after") || "";
  const filterBefore = searchParams.get("before") || "";
  const filterMinImportance = searchParams.get("min_importance") || "";

  const activeFilterCount = [filterContentType, filterAfter, filterBefore, filterMinImportance].filter(Boolean).length;

  const setFilterParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params);
    setPage(0);
  };

  const filterTags = searchParams.getAll("tag");

  const extraFilters = {
    content_type: filterContentType || undefined,
    after: filterAfter || undefined,
    before: filterBefore || undefined,
    min_importance: filterMinImportance ? Number(filterMinImportance) : undefined,
  };

  // Search mode: query + optional tag filter
  const { data: searchData, isLoading: searchLoading, error: searchError } = useQuery({
    queryKey: ["search", query, filterTags, page, extraFilters],
    queryFn: () => api.searchMemories(query, limit, filterTags.length > 0 ? filterTags : undefined, page * limit, extraFilters),
    enabled: query.length > 0,
  });

  // Browse mode: tag filter only, no query
  const { data: browseData, isLoading: browseLoading, error: browseError } = useQuery({
    queryKey: ["browse-tags", filterTags, page, extraFilters],
    queryFn: () => api.getRecent(limit, page * limit, filterTags, extraFilters),
    enabled: query.length === 0 && filterTags.length > 0,
  });

  const data = query.length > 0
    ? searchData && { results: searchData.results.map((r) => r.memory), count: searchData.count, searchResults: searchData.results as SearchResult[] | undefined }
    : browseData && { ...browseData, searchResults: undefined as SearchResult[] | undefined };
  const isLoading = searchLoading || browseLoading;
  const error = searchError || browseError;

  // Reset page when query changes
  const handleSearch = (q: string) => {
    setPage(0);
    setQuery(q);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTagClick = (tag: string) => {
    if (!filterTags.includes(tag)) {
      const params = new URLSearchParams(searchParams);
      params.append("tag", tag);
      setSearchParams(params);
      setPage(0);
    }
  };

  const removeTagFilter = (tag: string) => {
    const params = new URLSearchParams(searchParams);
    params.delete("tag");
    const remaining = filterTags.filter((t) => t !== tag);
    remaining.forEach((t) => params.append("tag", t));
    setSearchParams(params);
    setPage(0);
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
        queryClient.invalidateQueries({ queryKey: ["search"] });
        queryClient.invalidateQueries({ queryKey: ["browse-tags"] });
        queryClient.invalidateQueries({ queryKey: ["stats"] });
      } catch {
        toast("Failed to delete memories", "error");
      } finally {
        setDeleting(false);
      }
    });
  };

  // New memory form
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [newImportance, setNewImportance] = useState(0.5);
  const [newContentType, setNewContentType] = useState("text");

  const createMutation = useMutation({
    mutationFn: () =>
      api.createMemory({
        content: newContent,
        content_type: newContentType,
        tags: newTags.length > 0 ? newTags : undefined,
        importance: newImportance,
      }),
    onSuccess: () => {
      toast("Memory created", "success");
      setNewContent("");
      setNewTags([]);
      setNewTagInput("");
      setNewImportance(0.5);
      setNewContentType("text");
      setShowNewForm(false);
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["browse-tags"] });
      queryClient.invalidateQueries({ queryKey: ["recent"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err) => {
      toast((err as Error).message, "error");
    },
  });

  // Keyboard shortcuts
  useKeyboardShortcuts({
    "/": () => searchBarRef.current?.focus(),
    Escape: () => {
      if (selectMode) {
        setSelectMode(false);
        setSelectedIds(new Set());
      }
    },
    ArrowLeft: () => { if (data && page > 0) setPage((p) => p - 1); },
    ArrowRight: () => { if (data && data.count >= limit) setPage((p) => p + 1); },
  });

  const statsQuery = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.getStats(),
  });

  return (
    <div>
      <h1>Search</h1>
      <p style={{ color: "#8080a0", fontSize: 13, marginBottom: 24 }}>
        Query your second brain
      </p>

      <SearchBar onSearch={handleSearch} inputRef={searchBarRef} />

      {/* Quick filters */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, marginTop: 12, flexWrap: "wrap" }}>
        {([
          { tag: "session-fact", label: "Facts", color: "#8b5cf6" },
          { tag: "decision", label: "Decisions", color: "#8b5cf6" },
          { tag: "discovery", label: "Discoveries", color: "#22d3ee" },
          { tag: "architecture", label: "Architecture", color: "#34d399" },
          { tag: "learning", label: "Learnings", color: "#fbbf24" },
        ] as const).map((f) => {
          const active = filterTags.includes(f.tag);
          return (
            <button
              key={f.tag}
              onClick={() => handleTagClick(f.tag)}
              style={{
                background: active ? `${f.color}20` : `${f.color}0a`,
                color: active ? f.color : `${f.color}99`,
                border: `1px solid ${active ? `${f.color}55` : `${f.color}22`}`,
                borderRadius: 20,
                padding: "4px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.borderColor = `${f.color}44`; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.borderColor = `${f.color}22`; }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Active tag filters */}
      {filterTags.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#8080a0", marginRight: 4 }}>Filtered by:</span>
          {filterTags.map((tag) => (
            <span
              key={tag}
              style={{
                background: "rgba(139, 92, 246, 0.25)",
                color: "#c4b5fd",
                padding: "3px 10px",
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
                onClick={() => removeTagFilter(tag)}
                style={{ cursor: "pointer", opacity: 0.7, fontSize: 14, lineHeight: 1 }}
              >
                &times;
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Stat pills */}
      {statsQuery.data && !query && filterTags.length === 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <div className="stat-pill">
            <strong>{statsQuery.data.total_memories}</strong> memories
          </div>
          {statsQuery.data.total_entities > 0 && (
            <div className="stat-pill">
              <strong>{statsQuery.data.total_entities}</strong> entities
            </div>
          )}
          {statsQuery.data.total_tags > 0 && (
            <div className="stat-pill">
              <strong>{statsQuery.data.total_tags}</strong> tags
            </div>
          )}
        </div>
      )}

      {/* Enhanced Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button
          data-testid="search-filters-toggle"
          className="btn-ghost btn-sm"
          onClick={() => setShowFilters(!showFilters)}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="11" y1="18" x2="13" y2="18" />
          </svg>
          Filters
          {activeFilterCount > 0 && (
            <span style={{
              background: "#8b5cf6",
              color: "#fff",
              borderRadius: 10,
              padding: "1px 6px",
              fontSize: 10,
              fontWeight: 700,
              minWidth: 16,
              textAlign: "center",
            }}>
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {showFilters && (
        <div
          style={{
            background: "#0c0c1d",
            border: "1px solid #16163a",
            borderRadius: 10,
            padding: 16,
            marginBottom: 16,
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "flex-end",
            animation: "fadeIn 0.15s ease-out",
          }}
        >
          <div style={{ minWidth: 140 }}>
            <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              Content Type
            </div>
            <select
              data-testid="search-filter-content-type"
              value={filterContentType}
              onChange={(e) => setFilterParam("content_type", e.target.value)}
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              <option value="">All</option>
              <option value="text">Text</option>
              <option value="note">Note</option>
              <option value="summary">Summary</option>
              <option value="conversation">Conversation</option>
            </select>
          </div>
          <div style={{ minWidth: 140 }}>
            <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              After
            </div>
            <input
              type="date"
              value={filterAfter}
              onChange={(e) => setFilterParam("after", e.target.value)}
              style={{ padding: "6px 10px", fontSize: 12 }}
            />
          </div>
          <div style={{ minWidth: 140 }}>
            <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              Before
            </div>
            <input
              type="date"
              value={filterBefore}
              onChange={(e) => setFilterParam("before", e.target.value)}
              style={{ padding: "6px 10px", fontSize: 12 }}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              Min Importance {filterMinImportance && <span style={{ color: "#8b5cf6", fontFamily: "var(--font-mono)" }}>{filterMinImportance}</span>}
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={filterMinImportance || 0}
              onChange={(e) => setFilterParam("min_importance", Number(e.target.value) > 0 ? e.target.value : "")}
              style={{
                width: "100%",
                height: 4,
                appearance: "none",
                WebkitAppearance: "none",
                background: `linear-gradient(90deg, #8b5cf6 ${(Number(filterMinImportance) || 0) * 100}%, #16163a ${(Number(filterMinImportance) || 0) * 100}%)`,
                borderRadius: 2,
                outline: "none",
                cursor: "pointer",
              }}
            />
          </div>
          {activeFilterCount > 0 && (
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                params.delete("content_type");
                params.delete("after");
                params.delete("before");
                params.delete("min_importance");
                setSearchParams(params);
                setPage(0);
              }}
              style={{ color: "#8080a0" }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* New Memory Form */}
      {showNewForm && (
        <div
          style={{
            background: "#0c0c1d",
            border: "1px solid rgba(139, 92, 246, 0.3)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <div style={{ fontSize: 11, color: "#8b5cf6", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Memory
          </div>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Memory content..."
            rows={4}
            style={{
              width: "100%",
              background: "#06060e",
              border: "1px solid #16163a",
              borderRadius: 8,
              color: "#d0d0e0",
              padding: 14,
              fontSize: 14,
              lineHeight: 1.7,
              fontFamily: "inherit",
              resize: "vertical",
              outline: "none",
              transition: "border-color 0.2s",
              marginBottom: 12,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "#8b5cf6"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "#16163a"; }}
          />
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ minWidth: 120 }}>
              <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 4, textTransform: "uppercase", fontWeight: 600 }}>Type</div>
              <select value={newContentType} onChange={(e) => setNewContentType(e.target.value)} style={{ padding: "6px 10px", fontSize: 12 }}>
                <option value="text">Text</option>
                <option value="note">Note</option>
                <option value="summary">Summary</option>
                <option value="conversation">Conversation</option>
              </select>
            </div>
            <div style={{ minWidth: 160 }}>
              <div style={{ fontSize: 11, color: "#8080a0", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, display: "flex", justifyContent: "space-between" }}>
                <span>Importance</span>
                <span style={{ color: "#8b5cf6", fontFamily: "var(--font-mono)" }}>{newImportance.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={newImportance}
                onChange={(e) => setNewImportance(Number(e.target.value))}
                style={{
                  width: "100%",
                  height: 4,
                  appearance: "none",
                  WebkitAppearance: "none",
                  background: `linear-gradient(90deg, #8b5cf6 ${newImportance * 100}%, #16163a ${newImportance * 100}%)`,
                  borderRadius: 2,
                  outline: "none",
                  cursor: "pointer",
                }}
              />
            </div>
          </div>
          {/* Tags */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              {newTags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    background: "rgba(139, 92, 246, 0.15)",
                    color: "#8b5cf6",
                    padding: "3px 10px",
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {tag}
                  <span onClick={() => setNewTags(newTags.filter((t) => t !== tag))} style={{ cursor: "pointer", opacity: 0.7, fontSize: 14, lineHeight: 1 }}>&times;</span>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const tag = newTagInput.trim();
                    if (tag && !newTags.includes(tag)) setNewTags([...newTags, tag]);
                    setNewTagInput("");
                  }
                }}
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
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn-primary btn-sm"
              onClick={() => createMutation.mutate()}
              disabled={!newContent.trim() || createMutation.isPending}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {createMutation.isPending && <span className="spinner" style={{ width: 12, height: 12 }} />}
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setShowNewForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="loading">
          <div className="spinner" />
          <span>Searching...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <p style={{ color: "#f87171", fontSize: 14 }}>
          Error: {(error as Error).message}
        </p>
      )}

      {/* Results */}
      {data && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <p style={{ color: "#8080a0", fontSize: 13, fontFamily: "var(--font-mono)", margin: 0 }}>
              {data.count} result{data.count !== 1 ? "s" : ""}{page > 0 ? ` (page ${page + 1})` : ""}
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              {!showNewForm && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setShowNewForm(true)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New
                </button>
              )}
              {!selectMode && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setSelectMode(true)}
                >
                  Select
                </button>
              )}
            </div>
          </div>
          {data.results.map((memory, i) => {
            const sr = data.searchResults?.[i];
            return (
              <MemoryCard
                key={memory.id}
                memory={memory}
                score={sr?.score}
                scoreBreakdown={sr ? {
                  vector_score: sr.vector_score,
                  fts_score: sr.fts_score,
                  recency_score: sr.recency_score,
                  frequency_score: sr.frequency_score,
                } : undefined}
                selectable={selectMode}
                selected={selectedIds.has(memory.id)}
                onToggle={toggleSelect}
                onTagClick={handleTagClick}
              />
            );
          })}

          {/* Pagination */}
          <div style={{ display: "flex", gap: 10, marginTop: 20, marginBottom: selectMode ? 80 : 0, alignItems: "center" }}>
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
                  if (selectedIds.size === data.results.length) {
                    setSelectedIds(new Set());
                  } else {
                    setSelectedIds(new Set(data.results.map((m) => m.id)));
                  }
                }}
              >
                {selectedIds.size === data.results.length ? "Deselect all" : "Select all"}
              </button>

              <button
                className="btn-danger btn-sm"
                onClick={handleBulkDelete}
                disabled={deleting || selectedIds.size === 0}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
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
      )}
    </div>
  );
}
