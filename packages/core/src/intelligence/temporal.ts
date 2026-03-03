import type { DatabaseSync } from "node:sqlite";

export interface TimelineEntry {
  date: string;
  count: number;
  memories: Array<{
    id: string;
    content: string;
    content_type: string;
    source: string;
    importance: number;
  }>;
}

export interface TemporalStats {
  total_days: number;
  avg_per_day: number;
  most_active_day: string | null;
  most_active_count: number;
  streak_current: number;
  streak_longest: number;
}

/**
 * Get a timeline of memories grouped by date.
 */
export function getTimeline(
  db: DatabaseSync,
  options: {
    after?: string;
    before?: string;
    limit?: number;
    includeMemories?: boolean;
  } = {}
): TimelineEntry[] {
  const conditions: string[] = ["is_active = 1"];
  const params: (string | number)[] = [];

  if (options.after) {
    conditions.push("created_at >= ?");
    params.push(options.after);
  }
  if (options.before) {
    conditions.push("created_at <= ?");
    params.push(options.before);
  }

  const where = conditions.join(" AND ");

  // Get date counts
  const dateCounts = db
    .prepare(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM memories WHERE ${where}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT ?`
    )
    .all(...params, options.limit ?? 30) as unknown as Array<{
    date: string;
    count: number;
  }>;

  if (!options.includeMemories) {
    return dateCounts.map((d) => ({ ...d, memories: [] }));
  }

  // Fetch memories for each date
  return dateCounts.map((d) => {
    const memories = db
      .prepare(
        `SELECT id, content, content_type, source, importance
         FROM memories
         WHERE DATE(created_at) = ? AND is_active = 1
         ORDER BY importance DESC, created_at DESC
         LIMIT 20`
      )
      .all(d.date) as unknown as Array<{
      id: string;
      content: string;
      content_type: string;
      source: string;
      importance: number;
    }>;

    return { ...d, memories };
  });
}

/**
 * Get temporal statistics about memory creation patterns.
 */
// --- A4: Decision Lineage & Timeline ---

export interface LineageEntry {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  direction: "predecessor" | "current" | "successor";
  depth: number;
}

/**
 * Walk the superseded_by chain in both directions from a memory.
 * - Backward: find memories where superseded_by = currentId (predecessors)
 * - Forward: follow superseded_by from current (successors)
 */
export function getMemoryLineage(
  db: DatabaseSync,
  memoryId: string,
  maxDepth = 10
): LineageEntry[] {
  const entries: LineageEntry[] = [];

  // Get current memory
  const current = db
    .prepare("SELECT id, content, importance, created_at FROM memories WHERE id = ?")
    .get(memoryId) as { id: string; content: string; importance: number; created_at: string } | undefined;

  if (!current) return entries;

  // Walk backward: find predecessors (memories that were superseded by this one)
  const predecessors: LineageEntry[] = [];
  let currentId = memoryId;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const prev = db
      .prepare(
        "SELECT id, content, importance, created_at FROM memories WHERE superseded_by = ?"
      )
      .get(currentId) as { id: string; content: string; importance: number; created_at: string } | undefined;

    if (!prev) break;
    predecessors.push({ ...prev, direction: "predecessor", depth });
    currentId = prev.id;
  }

  // Add predecessors in chronological order (deepest first)
  predecessors.reverse();
  entries.push(...predecessors);

  // Add current
  entries.push({ ...current, direction: "current", depth: 0 });

  // Walk forward: follow superseded_by chain from current
  const currentFull = db
    .prepare("SELECT superseded_by FROM memories WHERE id = ?")
    .get(memoryId) as { superseded_by: string | null } | undefined;

  let nextId = currentFull?.superseded_by ?? null;
  for (let depth = 1; depth <= maxDepth && nextId; depth++) {
    const next = db
      .prepare(
        "SELECT id, content, importance, created_at, superseded_by FROM memories WHERE id = ?"
      )
      .get(nextId) as { id: string; content: string; importance: number; created_at: string; superseded_by: string | null } | undefined;

    if (!next) break;
    entries.push({ id: next.id, content: next.content, importance: next.importance, created_at: next.created_at, direction: "successor", depth });
    nextId = next.superseded_by;
  }

  return entries;
}

export interface DecisionTimelineEntry {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  tags: string[];
  superseded_by: string | null;
  supersedes: string | null;
}

/**
 * Query active memories tagged 'decision', ordered chronologically.
 * Includes supersession links in both directions.
 */
export function getDecisionTimeline(
  db: DatabaseSync,
  opts?: { after?: string; before?: string; limit?: number; tags?: string[] }
): DecisionTimelineEntry[] {
  const conditions: string[] = [
    "m.is_active = 1",
    "m.source != 'consolidation'",
    "m.id IN (SELECT memory_id FROM memory_tags WHERE tag = 'decision')",
  ];
  const params: (string | number)[] = [];

  if (opts?.after) {
    conditions.push("m.created_at >= ?");
    params.push(opts.after);
  }
  if (opts?.before) {
    conditions.push("m.created_at <= ?");
    params.push(opts.before);
  }

  // Additional tag filters (ANDed with 'decision')
  if (opts?.tags && opts.tags.length > 0) {
    for (const tag of opts.tags) {
      conditions.push(
        "m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)"
      );
      params.push(tag.toLowerCase().trim());
    }
  }

  const limit = opts?.limit ?? 50;
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.created_at, m.superseded_by
       FROM memories m
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(...params) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    created_at: string;
    superseded_by: string | null;
  }>;

  // For each entry, fetch tags and reverse supersession lookup
  return rows.map((row) => {
    const tags = (
      db
        .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
        .all(row.id) as unknown as Array<{ tag: string }>
    ).map((t) => t.tag);

    // Reverse lookup: who was superseded by this memory?
    const predecessor = db
      .prepare("SELECT id FROM memories WHERE superseded_by = ?")
      .get(row.id) as { id: string } | undefined;

    return {
      id: row.id,
      content: row.content,
      importance: row.importance,
      created_at: row.created_at,
      tags,
      superseded_by: row.superseded_by,
      supersedes: predecessor?.id ?? null,
    };
  });
}

export function getTemporalStats(db: DatabaseSync): TemporalStats {
  // Get all active dates
  const dates = db
    .prepare(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM memories WHERE is_active = 1
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    )
    .all() as unknown as Array<{ date: string; count: number }>;

  if (dates.length === 0) {
    return {
      total_days: 0,
      avg_per_day: 0,
      most_active_day: null,
      most_active_count: 0,
      streak_current: 0,
      streak_longest: 0,
    };
  }

  const totalMemories = dates.reduce((sum, d) => sum + d.count, 0);
  const totalDays = dates.length;

  // Most active day
  let mostActive = dates[0];
  for (const d of dates) {
    if (d.count > mostActive.count) mostActive = d;
  }

  // Calculate streaks
  const dateSet = new Set(dates.map((d) => d.date));
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;

  // Walk backwards from today to find current streak
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];

    if (dateSet.has(dateStr)) {
      currentStreak++;
    } else if (i > 0) {
      // Allow missing today (might not have added anything yet)
      break;
    }
  }

  // Walk through all dates for longest streak
  const sortedDates = Array.from(dateSet).sort();
  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      tempStreak = 1;
    } else {
      const prev = new Date(sortedDates[i - 1]);
      const curr = new Date(sortedDates[i]);
      const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

      if (diffDays === 1) {
        tempStreak++;
      } else {
        tempStreak = 1;
      }
    }
    if (tempStreak > longestStreak) longestStreak = tempStreak;
  }

  return {
    total_days: totalDays,
    avg_per_day: Math.round((totalMemories / totalDays) * 100) / 100,
    most_active_day: mostActive.date,
    most_active_count: mostActive.count,
    streak_current: currentStreak,
    streak_longest: longestStreak,
  };
}

// --- Hierarchical Temporal Organization ---

export interface HierarchyEpisode {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  tags: string[];
  linked: boolean;
}

export interface HierarchyTheme {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  linked: boolean;
  episodes: HierarchyEpisode[];
}

export interface HierarchyEpoch {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  month: string;
  themes: HierarchyTheme[];
}

export interface TemporalHierarchy {
  epochs: HierarchyEpoch[];
  orphan_themes: HierarchyTheme[];
  time_range: { start: string; end: string } | null;
}

export interface TemporalHierarchyOptions {
  month?: string; // YYYY-MM
  after?: string;
  before?: string;
  maxEpisodes?: number;
}

export function getTemporalHierarchy(
  db: DatabaseSync,
  options: TemporalHierarchyOptions = {}
): TemporalHierarchy {
  const maxEpisodes = options.maxEpisodes ?? 20;

  // Build date conditions
  const dateConditions: string[] = [];
  const dateParams: string[] = [];

  if (options.month) {
    dateConditions.push("strftime('%Y-%m', m.created_at) = ?");
    dateParams.push(options.month);
  }
  if (options.after) {
    dateConditions.push("m.created_at >= ?");
    dateParams.push(options.after);
  }
  if (options.before) {
    dateConditions.push("m.created_at <= ?");
    dateParams.push(options.before);
  }

  const dateWhere =
    dateConditions.length > 0 ? " AND " + dateConditions.join(" AND ") : "";

  // 1. Query epochs (tagged 'epoch')
  const epochRows = db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.created_at,
              strftime('%Y-%m', m.created_at) as month
       FROM memories m
       JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = 'epoch'
       WHERE m.is_active = 1${dateWhere}
       ORDER BY m.created_at DESC`
    )
    .all(...dateParams) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    created_at: string;
    month: string;
  }>;

  // 2. Query themes (tagged 'narrative')
  const themeRows = db
    .prepare(
      `SELECT m.id, m.content, m.importance, m.created_at,
              strftime('%Y-%m', m.created_at) as month
       FROM memories m
       JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = 'narrative'
       WHERE m.is_active = 1${dateWhere}
       ORDER BY m.created_at DESC`
    )
    .all(...dateParams) as unknown as Array<{
    id: string;
    content: string;
    importance: number;
    created_at: string;
    month: string;
  }>;

  // 3. Check for explicit 'elaborates' links
  const linkedSet = new Set<string>();
  if (epochRows.length > 0 || themeRows.length > 0) {
    const allIds = [
      ...epochRows.map((e) => e.id),
      ...themeRows.map((t) => t.id),
    ];

    for (const id of allIds) {
      const links = db
        .prepare(
          `SELECT source_id, target_id FROM memory_links
           WHERE (source_id = ? OR target_id = ?) AND link_type = 'elaborates'`
        )
        .all(id, id) as unknown as Array<{
        source_id: string;
        target_id: string;
      }>;

      for (const link of links) {
        linkedSet.add(link.source_id);
        linkedSet.add(link.target_id);
      }
    }
  }

  // 4. For each theme, find episodes in its 7-day window
  const tagStmt = db.prepare(
    "SELECT tag FROM memory_tags WHERE memory_id = ?"
  );

  function getEpisodesForWindow(
    before: string,
    afterDate: string
  ): HierarchyEpisode[] {
    const episodes = db
      .prepare(
        `SELECT m.id, m.content, m.importance, m.created_at
         FROM memories m
         WHERE m.is_active = 1
           AND m.is_metadata = 0
           AND m.created_at >= ? AND m.created_at < ?
           AND m.id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'epoch')
           AND m.id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'narrative')
         ORDER BY m.importance DESC
         LIMIT ?`
      )
      .all(afterDate, before, maxEpisodes) as unknown as Array<{
      id: string;
      content: string;
      importance: number;
      created_at: string;
    }>;

    return episodes.map((ep) => {
      const tags = (tagStmt.all(ep.id) as unknown as Array<{ tag: string }>).map(
        (t) => t.tag
      );
      return { ...ep, tags, linked: linkedSet.has(ep.id) };
    });
  }

  // Build themes with episodes
  const themes: Array<HierarchyTheme & { month: string }> = themeRows.map(
    (t) => {
      const themeDate = new Date(t.created_at);
      const weekBefore = new Date(
        themeDate.getTime() - 7 * 24 * 60 * 60 * 1000
      );
      const episodes = getEpisodesForWindow(
        t.created_at,
        weekBefore.toISOString().replace("T", " ").slice(0, 19)
      );

      return {
        id: t.id,
        content: t.content,
        importance: t.importance,
        created_at: t.created_at,
        linked: linkedSet.has(t.id),
        month: t.month,
        episodes,
      };
    }
  );

  // 5. Group themes under epochs by month
  const epochMap = new Map<string, HierarchyEpoch>();

  for (const epoch of epochRows) {
    epochMap.set(epoch.month, {
      id: epoch.id,
      content: epoch.content,
      importance: epoch.importance,
      created_at: epoch.created_at,
      month: epoch.month,
      themes: [],
    });
  }

  const orphanThemes: HierarchyTheme[] = [];

  for (const theme of themes) {
    const epoch = epochMap.get(theme.month);
    const { month: _, ...themeWithoutMonth } = theme;
    if (epoch) {
      epoch.themes.push(themeWithoutMonth);
    } else {
      orphanThemes.push(themeWithoutMonth);
    }
  }

  // Time range
  const allDates = [
    ...epochRows.map((e) => e.created_at),
    ...themeRows.map((t) => t.created_at),
  ].sort();
  const timeRange =
    allDates.length > 0
      ? { start: allDates[0], end: allDates[allDates.length - 1] }
      : null;

  return {
    epochs: Array.from(epochMap.values()),
    orphan_themes: orphanThemes,
    time_range: timeRange,
  };
}
