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
