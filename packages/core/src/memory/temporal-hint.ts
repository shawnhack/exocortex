/**
 * Temporal hint detection — parse time-references from natural-language queries
 * and convert them to date-window filters.
 *
 * Used by the MCP search layer to auto-populate `after`/`before` when the
 * caller asks a time-sensitive question without explicit date filters. This
 * addresses a known QA-eval failure category: queries like "yesterday's
 * autonomous run outcome" surface old (Feb 2026) outcomes instead of recent
 * ones, because vector + FTS scoring don't naturally know that "yesterday"
 * implies a date constraint.
 *
 * Design choice: produces hard filters (`after`/`before`), not soft scoring
 * boosts. Caller can override by passing explicit filters (the auto-injection
 * only fires when those fields are unset). If a temporal-hinted query produces
 * zero results, the caller may want to retry without the hint — that fallback
 * is the caller's policy decision, not this module's.
 */

export interface TemporalHint {
  /** ISO datetime string for the start of the window (inclusive) */
  after?: string;
  /** ISO datetime string for the end of the window (inclusive) */
  before?: string;
  /** The matched phrase that triggered the hint */
  matched: string;
}

/**
 * Parse a query for temporal hints. Returns null if no hint detected.
 *
 * Recognized phrases (case-insensitive):
 *   - "today" → window [today 00:00, now]
 *   - "yesterday" → window [yesterday 00:00, today 00:00]
 *   - "this week" → window [start of week (Sun), now]
 *   - "last week" → window [start of last week, start of this week]
 *   - "this month" → window [start of month, now]
 *   - "recently" → window [7 days ago, now]
 *   - "in the past N day(s)|hour(s)|week(s)|month(s)" → window [now - N units, now]
 *   - "last N day(s)|hour(s)|week(s)|month(s)" → same as above
 *   - "since YYYY-MM-DD" → window [date, now]
 *
 * Multi-phrase queries: returns the FIRST detected phrase. If the query
 * contains "yesterday" and "last week", we honor "yesterday" (more specific).
 * The caller can override by passing explicit `after`/`before`.
 */
export function parseTemporalHint(query: string, now: Date = new Date()): TemporalHint | null {
  if (!query || query.length === 0) return null;
  const q = query.toLowerCase();

  // Helper: format a Date as ISO string trimmed to seconds (matches DB datetime() format)
  const toIso = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

  const startOfDay = (d: Date) => {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    return out;
  };

  const startOfWeek = (d: Date) => {
    const out = startOfDay(d);
    out.setDate(out.getDate() - out.getDay()); // back to Sunday
    return out;
  };

  const startOfMonth = (d: Date) => {
    const out = startOfDay(d);
    out.setDate(1);
    return out;
  };

  // Order matters: more-specific patterns first.

  // "yesterday's X" or "yesterday"
  if (/\byesterday\b/.test(q)) {
    const today = startOfDay(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return {
      after: toIso(yesterday),
      before: toIso(today),
      matched: "yesterday",
    };
  }

  // "today's X" or "today"
  if (/\btoday('s)?\b/.test(q)) {
    return {
      after: toIso(startOfDay(now)),
      before: toIso(now),
      matched: "today",
    };
  }

  // "last week"
  if (/\blast week\b/.test(q)) {
    const thisWeek = startOfWeek(now);
    const lastWeek = new Date(thisWeek);
    lastWeek.setDate(lastWeek.getDate() - 7);
    return {
      after: toIso(lastWeek),
      before: toIso(thisWeek),
      matched: "last week",
    };
  }

  // "this week"
  if (/\bthis week\b/.test(q)) {
    return {
      after: toIso(startOfWeek(now)),
      before: toIso(now),
      matched: "this week",
    };
  }

  // "last month"
  if (/\blast month\b/.test(q)) {
    const thisMonth = startOfMonth(now);
    const lastMonth = new Date(thisMonth);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    return {
      after: toIso(lastMonth),
      before: toIso(thisMonth),
      matched: "last month",
    };
  }

  // "this month"
  if (/\bthis month\b/.test(q)) {
    return {
      after: toIso(startOfMonth(now)),
      before: toIso(now),
      matched: "this month",
    };
  }

  // "in the past N <unit>" or "last N <unit>" or "past N <unit>"
  const pastN = q.match(
    /\b(?:in the past|last|past)\s+(\d+)\s+(hour|day|week|month)s?\b/,
  );
  if (pastN) {
    const n = parseInt(pastN[1], 10);
    const unit = pastN[2];
    const after = new Date(now);
    if (unit === "hour") after.setHours(after.getHours() - n);
    else if (unit === "day") after.setDate(after.getDate() - n);
    else if (unit === "week") after.setDate(after.getDate() - n * 7);
    else if (unit === "month") after.setMonth(after.getMonth() - n);
    return {
      after: toIso(after),
      before: toIso(now),
      matched: pastN[0],
    };
  }

  // "since YYYY-MM-DD"
  const sinceDate = q.match(/\bsince\s+(\d{4}-\d{2}-\d{2})\b/);
  if (sinceDate) {
    return {
      after: `${sinceDate[1]} 00:00:00`,
      before: toIso(now),
      matched: sinceDate[0],
    };
  }

  // "recently" — softest hint, last priority. Default 7 days.
  if (/\brecently\b/.test(q)) {
    const after = new Date(now);
    after.setDate(after.getDate() - 7);
    return {
      after: toIso(after),
      before: toIso(now),
      matched: "recently",
    };
  }

  return null;
}
