import { useState, useRef, useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type SearchResult } from "../api/client";
import { SearchBar } from "../components/SearchBar";
import { MemoryCard } from "../components/MemoryCard";
import { useToast } from "../components/Toast";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { parseUTC } from "../utils/format";

function formatDate(dateStr: string): string {
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
    const d = parseUTC(m.created_at);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!groups[date]) groups[date] = [];
    groups[date].push(m);
  }
  return Object.entries(groups);
}

export function Search() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [showBulkTagInput, setShowBulkTagInput] = useState(false);
  const [bulkTagValue, setBulkTagValue] = useState("");
  const [bulkingTags, setBulkingTags] = useState(false);
  const [showBulkImportance, setShowBulkImportance] = useState(false);
  const [bulkImportanceValue, setBulkImportanceValue] = useState(0.5);
  const [bulkingImportance, setBulkingImportance] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const searchBarRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const [stickyHeight, setStickyHeight] = useState(0);
  const limit = 20;

  // Filter state
  const filterContentType = searchParams.get("content_type") || "";
  const filterAfter = searchParams.get("after") || "";
  const filterBefore = searchParams.get("before") || "";
  const filterMinImportance = searchParams.get("min_importance") || "";
  const filterNamespace = searchParams.get("namespace") || "";
  const filterTier = searchParams.get("tier") || "";

  const activeFilterCount = [filterContentType, filterAfter, filterBefore, filterMinImportance, filterNamespace, filterTier].filter(Boolean).length;

  const setFilterParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params);
  };

  const filterTags = searchParams.getAll("tag");

  const extraFilters = {
    content_type: filterContentType || undefined,
    after: filterAfter || undefined,
    before: filterBefore || undefined,
    min_importance: filterMinImportance ? Number(filterMinImportance) : undefined,
    namespace: filterNamespace || undefined,
    tier: filterTier || undefined,
  };

  // Search mode: query + optional tag filter
  const {
    data: searchData,
    isLoading: searchLoading,
    error: searchError,
    fetchNextPage: fetchNextSearch,
    hasNextPage: hasNextSearch,
    isFetchingNextPage: isFetchingNextSearch,
  } = useInfiniteQuery({
    queryKey: ["search", query, filterTags, extraFilters],
    queryFn: ({ pageParam = 0 }) =>
      api.searchMemories(query, limit, filterTags.length > 0 ? filterTags : undefined, pageParam, extraFilters),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.results.length < limit) return undefined;
      return allPages.reduce((n, p) => n + p.results.length, 0);
    },
    enabled: query.length > 0,
  });

  // Browse mode: tag filter only, no query
  const {
    data: browseData,
    isLoading: browseLoading,
    error: browseError,
    fetchNextPage: fetchNextBrowse,
    hasNextPage: hasNextBrowse,
    isFetchingNextPage: isFetchingNextBrowse,
  } = useInfiniteQuery({
    queryKey: ["browse-tags", filterTags, extraFilters],
    queryFn: ({ pageParam = 0 }) =>
      api.getRecent(limit, pageParam, filterTags, extraFilters),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.results.length < limit) return undefined;
      return allPages.reduce((n, p) => n + p.results.length, 0);
    },
    enabled: query.length === 0,
  });

  const allResults = useMemo(
    () => query.length > 0
      ? searchData?.pages.flatMap(p => p.results.map(r => r.memory)) ?? []
      : browseData?.pages.flatMap(p => p.results) ?? [],
    [query.length, searchData?.pages, browseData?.pages]
  );

  const allSearchResults = useMemo(
    () => query.length > 0
      ? searchData?.pages.flatMap(p => p.results) ?? []
      : [],
    [query.length, searchData?.pages]
  );

  const groupedResults = useMemo(
    () => groupByDate(allResults as any),
    [allResults]
  );

  const totalCount = allResults.length;
  const hasData = query.length > 0 ? !!searchData : !!browseData;
  const isLoading = searchLoading || browseLoading;
  const error = searchError || browseError;
  const isFetchingNext = isFetchingNextSearch || isFetchingNextBrowse;
  const hasNext = query.length > 0 ? hasNextSearch : hasNextBrowse;

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const fetchNext = query.length > 0 ? fetchNextSearch : fetchNextBrowse;
    if (!hasNext || isFetchingNext) return;

    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) fetchNext(); },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [query, hasNextSearch, hasNextBrowse, fetchNextSearch, fetchNextBrowse, isFetchingNextSearch, isFetchingNextBrowse]);

  // Measure sticky header height for date sub-headers
  useEffect(() => {
    const el = stickyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setStickyHeight(entry.borderBoxSize[0].blockSize));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset page when query changes
  const handleSearch = (q: string) => {
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
    }
  };

  const removeTagFilter = (tag: string) => {
    const params = new URLSearchParams(searchParams);
    params.delete("tag");
    const remaining = filterTags.filter((t) => t !== tag);
    remaining.forEach((t) => params.append("tag", t));
    setSearchParams(params);
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

  const handleBulkAddTags = async () => {
    const tags = bulkTagValue.split(",").map(t => t.trim()).filter(Boolean);
    if (tags.length === 0 || selectedIds.size === 0) return;
    setBulkingTags(true);
    try {
      await api.bulkTag([...selectedIds], tags);
      toast(`Added ${tags.length} tag(s) to ${selectedIds.size} memories`, "success");
      setBulkTagValue("");
      setShowBulkTagInput(false);
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["browse-tags"] });
    } catch {
      toast("Failed to add tags", "error");
    } finally {
      setBulkingTags(false);
    }
  };

  const handleBulkImportance = async () => {
    if (selectedIds.size === 0) return;
    setBulkingImportance(true);
    try {
      await api.bulkUpdateImportance([...selectedIds], bulkImportanceValue);
      toast(`Set importance to ${bulkImportanceValue.toFixed(2)} on ${selectedIds.size} memories`, "success");
      setShowBulkImportance(false);
      queryClient.invalidateQueries({ queryKey: ["search"] });
      queryClient.invalidateQueries({ queryKey: ["browse-tags"] });
    } catch {
      toast("Failed to update importance", "error");
    } finally {
      setBulkingImportance(false);
    }
  };

  // New memory form
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [newImportance, setNewImportance] = useState(0.5);
  const [newContentType, setNewContentType] = useState("text");
  const [newSourceUri, setNewSourceUri] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newProvider, setNewProvider] = useState("");

  const createMutation = useMutation({
    mutationFn: () => {
      const model = newModel.trim();
      const provider = newProvider.trim();
      return api.createMemory({
        content: newContent,
        content_type: newContentType,
        tags: newTags.length > 0 ? newTags : undefined,
        importance: newImportance,
        source_uri: newSourceUri.trim() || undefined,
        model_name: model || undefined,
        provider: provider || undefined,
      });
    },
    onSuccess: () => {
      toast("Memory created", "success");
      setNewContent("");
      setNewTags([]);
      setNewTagInput("");
      setNewImportance(0.5);
      setNewContentType("text");
      setNewSourceUri("");
      setNewModel("");
      setNewProvider("");
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
  });

  const { data: namespacesData } = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.getNamespaces(),
    staleTime: 5 * 60 * 1000,
  });

  const statsQuery = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.getStats(),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 64px)", minHeight: 0 }}>
      {/* Sticky header — negative margin extends into <main> padding so it sticks flush at top */}
      <div ref={stickyRef} style={{ flexShrink: 0, zIndex: 10, background: "var(--bg-root, #06060e)", margin: "-32px -40px 0", padding: "32px 40px 4px" }}>
        <h1>Memories</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
          Search, browse, and manage your second brain
        </p>

        <SearchBar onSearch={handleSearch} inputRef={searchBarRef} />

        {/* Quick filters */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12, marginTop: 12, flexWrap: "wrap" }}>
          <button
            onClick={() => {
              setQuery("");
              setSearchParams(new URLSearchParams());
            }}
            style={{
              background: !query && filterTags.length === 0 && !filterTier && activeFilterCount === 0
                ? "var(--cyan-border-dim)"
                : "var(--cyan-bg-faint)",
              color: !query && filterTags.length === 0 && !filterTier && activeFilterCount === 0
                ? "var(--cyan)"
                : "rgba(34, 211, 238, 0.6)",
              border: `1px solid ${!query && filterTags.length === 0 && !filterTier && activeFilterCount === 0 ? "var(--cyan-glow-subtle)" : "var(--cyan-bg)"}`,
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
          >
            Recent
          </button>
          {([
            { tier: "episodic", label: "Episodic", color: "var(--amber)" },
            { tier: "semantic", label: "Semantic", color: "var(--purple)" },
            { tier: "procedural", label: "Procedural", color: "var(--emerald)" },
            { tier: "reference", label: "Reference", color: "var(--sky)" },
            { tier: "working", label: "Working", color: "var(--text-muted)" },
          ] as const).map((f) => {
            const active = filterTier === f.tier;
            return (
              <button
                key={f.tier}
                onClick={() => setFilterParam("tier", active ? "" : f.tier)}
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
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 4 }}>Filtered by:</span>
            {filterTags.map((tag) => (
              <span
                key={tag}
                style={{
                  background: "var(--cyan-bg-hover)",
                  color: "var(--cyan-lighter)",
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
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove ${tag} filter`}
                  onClick={() => removeTagFilter(tag)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); removeTagFilter(tag); } }}
                  style={{ cursor: "pointer", opacity: 0.7, fontSize: 14, lineHeight: 1 }}
                >
                  &times;
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Stats cards */}
        {statsQuery.data && !query && filterTags.length === 0 && statsQuery.data.total_memories > 0 && (
          <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            {[
              { label: "Memories", value: statsQuery.data.total_memories },
              { label: "Entities", value: statsQuery.data.total_entities },
              { label: "Tags", value: statsQuery.data.total_tags },
              ...(statsQuery.data.by_source
                ? Object.entries(statsQuery.data.by_source).map(([source, count]) => ({
                    label: source.charAt(0).toUpperCase() + source.slice(1),
                    value: count,
                  }))
                : []),
            ]
              .filter((s) => s.value > 0)
              .map((s) => (
                <div
                  key={s.label}
                  style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: "14px 20px",
                    minWidth: 110,
                    flex: "1 1 0",
                    maxWidth: 180,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 22,
                      fontWeight: 700,
                      color: "var(--cyan)",
                      lineHeight: 1.2,
                    }}
                  >
                    {s.value.toLocaleString()}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      marginTop: 2,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      fontWeight: 600,
                    }}
                  >
                    {s.label}
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* Enhanced Filters toggle */}
        <div style={{ display: "flex", gap: 8, marginBottom: 0, alignItems: "center" }}>
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
                background: "var(--cyan)",
                color: "var(--black)",
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

        {/* Result count bar */}
        {hasData && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, paddingBottom: 4 }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, fontFamily: "var(--font-mono)", margin: 0 }}>
              {totalCount} result{totalCount !== 1 ? "s" : ""}{hasNext ? "+" : ""}
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
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", margin: "0 -40px", padding: "0 40px" }}>
      {showFilters && (
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
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
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
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
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              Tier
            </div>
            <select
              value={filterTier}
              onChange={(e) => setFilterParam("tier", e.target.value)}
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              <option value="">All</option>
              <option value="episodic">Episodic</option>
              <option value="semantic">Semantic</option>
              <option value="procedural">Procedural</option>
              <option value="reference">Reference</option>
              <option value="working">Working</option>
            </select>
          </div>
          {namespacesData && namespacesData.namespaces.length > 0 && (
            <div style={{ minWidth: 140 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
                Namespace
              </div>
              <select
                value={filterNamespace}
                onChange={(e) => setFilterParam("namespace", e.target.value)}
                style={{ padding: "6px 10px", fontSize: 12 }}
              >
                <option value="">All</option>
                {namespacesData.namespaces.map((ns) => (
                  <option key={ns} value={ns}>{ns}</option>
                ))}
              </select>
            </div>
          )}
          <div style={{ minWidth: 140 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
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
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
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
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              Min Importance {filterMinImportance && <span style={{ color: "var(--cyan)", fontFamily: "var(--font-mono)" }}>{filterMinImportance}</span>}
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
                background: `linear-gradient(90deg, #22d3ee ${(Number(filterMinImportance) || 0) * 100}%, #16163a ${(Number(filterMinImportance) || 0) * 100}%)`,
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
                params.delete("tier");
                params.delete("after");
                params.delete("before");
                params.delete("min_importance");
                params.delete("namespace");
                setSearchParams(params);
              }}
              style={{ color: "var(--text-muted)" }}
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
            background: "var(--bg-surface)",
            border: "1px solid var(--cyan-border)",
            borderRadius: 12,
            padding: 20,
            marginBottom: 20,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--cyan)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
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
              background: "var(--bg-deep)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 8,
              color: "var(--text-body)",
              padding: 14,
              fontSize: 14,
              lineHeight: 1.7,
              fontFamily: "inherit",
              resize: "vertical",
              outline: "none",
              transition: "border-color 0.2s",
              marginBottom: 12,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--cyan)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-subtle)"; }}
          />
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ minWidth: 120 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600 }}>Type</div>
              <select value={newContentType} onChange={(e) => setNewContentType(e.target.value)} style={{ padding: "6px 10px", fontSize: 12 }}>
                <option value="text">Text</option>
                <option value="note">Note</option>
                <option value="summary">Summary</option>
                <option value="conversation">Conversation</option>
              </select>
            </div>
            <div style={{ minWidth: 160 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, display: "flex", justifyContent: "space-between" }}>
                <span>Importance</span>
                <span style={{ color: "var(--cyan)", fontFamily: "var(--font-mono)" }}>{newImportance.toFixed(1)}</span>
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
                  background: `linear-gradient(90deg, #22d3ee ${newImportance * 100}%, #16163a ${newImportance * 100}%)`,
                  borderRadius: 2,
                  outline: "none",
                  cursor: "pointer",
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ minWidth: 280, flex: 1 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600 }}>
                Source URI
              </div>
              <input
                type="text"
                value={newSourceUri}
                onChange={(e) => setNewSourceUri(e.target.value)}
                placeholder="Optional source URI..."
                style={{
                  width: "100%",
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  color: "var(--text-body)",
                  padding: "6px 10px",
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ minWidth: 180, flex: 1 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600 }}>
                Model
              </div>
              <input
                type="text"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="gpt-5"
                style={{
                  width: "100%",
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  color: "var(--text-body)",
                  padding: "6px 10px",
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ minWidth: 180, flex: 1 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600 }}>
                Provider
              </div>
              <input
                type="text"
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
                placeholder="openai"
                style={{
                  width: "100%",
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  color: "var(--text-body)",
                  padding: "6px 10px",
                  fontSize: 12,
                  outline: "none",
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
                    background: "var(--cyan-bg)",
                    color: "var(--cyan)",
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
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  color: "var(--text-body)",
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
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowNewForm(false);
                setNewSourceUri("");
                setNewModel("");
                setNewProvider("");
              }}
            >
              Cancel
            </button>
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
        <p style={{ color: "var(--red)", fontSize: 14 }}>
          Error: {(error as Error).message}
        </p>
      )}

      {/* Empty state — no memories at all */}
      {!isLoading && !error && statsQuery.data && statsQuery.data.total_memories === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "64px 24px",
            animation: "fadeIn 0.3s ease-out",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              margin: "0 auto 16px",
              borderRadius: "50%",
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
              <line x1="9" y1="21" x2="15" y2="21" />
            </svg>
          </div>
          <h3 style={{ color: "var(--text-secondary)", fontSize: 16, marginBottom: 8 }}>
            No memories yet
          </h3>
          <p style={{ color: "var(--text-dim)", fontSize: 13, maxWidth: 380, margin: "0 auto", lineHeight: 1.7 }}>
            Connect an AI agent via MCP to start building your knowledge base, or create a memory manually using the form above.
          </p>
          <a
            href="https://github.com/shawnhack/exocortex#readme"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              marginTop: 16,
              padding: "8px 20px",
              borderRadius: 20,
              border: "1px solid rgba(34, 211, 238, 0.25)",
              background: "var(--cyan-dim)",
              color: "var(--cyan)",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              transition: "all 0.2s",
            }}
          >
            View Documentation
          </a>
        </div>
      )}

      {/* Empty search results */}
      {!isLoading && hasData && allResults.length === 0 && query.length > 0 && (
        <div className="empty-state">
          <h3>No results found</h3>
          <p style={{ fontSize: 13 }}>Try a different search query or adjust your filters.</p>
        </div>
      )}

      {/* Results */}
      {hasData && allResults.length > 0 && (
        <div>
          {query.length > 0 ? (
            allResults.map((memory, i) => {
              const sr = allSearchResults[i];
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
                    ...(sr.score_breakdown ?? {}),
                  } : undefined}
                  selectable={selectMode}
                  selected={selectedIds.has(memory.id)}
                  onToggle={toggleSelect}
                  onTagClick={handleTagClick}
                />
              );
            })
          ) : (
            groupedResults.map(([date, memories]) => (
              <div key={date} style={{ marginBottom: 24 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 12,
                    position: "sticky",
                    top: 0,
                    background: "var(--bg-root, #06060e)",
                    paddingTop: 8,
                    paddingBottom: 8,
                    zIndex: 5,
                  }}
                >
                  <div
                    style={{
                      width: 3,
                      height: 20,
                      borderRadius: 2,
                      background: "linear-gradient(180deg, var(--cyan), var(--cyan-dark))",
                    }}
                  />
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-secondary-alt)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {formatDate(date)}
                  </span>
                </div>
                <div style={{ paddingLeft: 15, borderLeft: "1px solid var(--border-subtle)" }}>
                  {(memories as any[]).map((memory) => (
                    <MemoryCard
                      key={memory.id}
                      memory={memory}
                      selectable={selectMode}
                      selected={selectedIds.has(memory.id)}
                      onToggle={toggleSelect}
                      onTagClick={handleTagClick}
                    />
                  ))}
                </div>
              </div>
            ))
          )}

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {isFetchingNext && (
            <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
              <div className="spinner" />
            </div>
          )}
          {!hasNext && allResults.length > 0 && allResults.length >= limit && (
            <p style={{ textAlign: "center", color: "var(--text-disabled)", fontSize: 12, padding: 16, marginBottom: selectMode ? 80 : 0 }}>
              All {totalCount} memories loaded
            </p>
          )}

          {/* Floating select action bar */}
          {selectMode && (
            <div
              style={{
                position: "fixed",
                bottom: 24,
                left: "50%",
                transform: "translateX(-50%)",
                background: "var(--bg-surface)",
                border: "1px solid var(--cyan-border)",
                borderRadius: 14,
                padding: "10px 20px",
                display: "flex",
                alignItems: "center",
                gap: 16,
                boxShadow: "var(--shadow-heavy), var(--glow-cyan-subtle)",
                zIndex: 100,
                animation: "fadeIn 0.2s ease-out",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  color: selectedIds.size > 0 ? "var(--cyan-light)" : "var(--text-muted)",
                  fontWeight: 600,
                  minWidth: 90,
                }}
              >
                {selectedIds.size} selected
              </span>

              <div style={{ width: 1, height: 20, background: "var(--border-subtle)" }} />

              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  if (selectedIds.size === allResults.length) {
                    setSelectedIds(new Set());
                  } else {
                    setSelectedIds(new Set(allResults.map((m) => m.id)));
                  }
                }}
              >
                {selectedIds.size === allResults.length ? "Deselect all" : "Select all"}
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

              {/* Bulk Add Tags */}
              {!showBulkTagInput ? (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setShowBulkTagInput(true)}
                  disabled={selectedIds.size === 0}
                >
                  Add Tags
                </button>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="text"
                    value={bulkTagValue}
                    onChange={(e) => setBulkTagValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleBulkAddTags(); }}
                    placeholder="tag1, tag2"
                    autoFocus
                    style={{
                      background: "var(--bg-deep)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 6,
                      color: "var(--text-body)",
                      padding: "4px 8px",
                      fontSize: 12,
                      width: 120,
                      outline: "none",
                    }}
                  />
                  <button className="btn-primary btn-sm" onClick={handleBulkAddTags} disabled={bulkingTags}>
                    {bulkingTags ? "..." : "Add"}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => { setShowBulkTagInput(false); setBulkTagValue(""); }} style={{ padding: "4px 6px" }}>
                    &times;
                  </button>
                </div>
              )}

              {/* Bulk Set Importance */}
              {!showBulkImportance ? (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setShowBulkImportance(true)}
                  disabled={selectedIds.size === 0}
                >
                  Set Importance
                </button>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={bulkImportanceValue}
                    onChange={(e) => setBulkImportanceValue(Number(e.target.value))}
                    style={{ width: 80, height: 4, appearance: "none", WebkitAppearance: "none", background: `linear-gradient(90deg, #22d3ee ${bulkImportanceValue * 100}%, #16163a ${bulkImportanceValue * 100}%)`, borderRadius: 2, outline: "none", cursor: "pointer" }}
                  />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--cyan)", minWidth: 28 }}>{bulkImportanceValue.toFixed(2)}</span>
                  <button className="btn-primary btn-sm" onClick={handleBulkImportance} disabled={bulkingImportance}>
                    {bulkingImportance ? "..." : "Set"}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setShowBulkImportance(false)} style={{ padding: "4px 6px" }}>
                    &times;
                  </button>
                </div>
              )}

              <div style={{ width: 1, height: 20, background: "var(--border-subtle)" }} />

              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  setSelectMode(false);
                  setSelectedIds(new Set());
                  setShowBulkTagInput(false);
                  setShowBulkImportance(false);
                }}
                style={{ color: "var(--text-muted)" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
