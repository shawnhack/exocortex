/**
 * Detect temporal language in memory content and return a suggested expiry date.
 * Inspired by Supermemory's automatic forgetting of temporal facts.
 *
 * Detects patterns like:
 * - "tomorrow", "today", "tonight" → +1 day
 * - "next week", "this week" → +7 days
 * - "next month", "this month" → +30 days
 * - "by Friday", "on Monday" → next occurrence of that day
 * - "in X days/hours/weeks" → +X duration
 */

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Detect temporal language that implies an ephemeral fact and return a suggested expiry.
 *
 * Only triggers on strong temporal signals — patterns that clearly indicate a
 * time-bound fact (meetings, deadlines, appointments). Avoids false positives
 * on general statements like "React is popular today" by requiring temporal
 * words to appear with action/event context.
 */
export function detectTemporalExpiry(content: string): string | null {
  const lower = content.toLowerCase();

  // "in X days/hours/weeks/months" — strong signal, always temporal
  const inDuration = lower.match(/\bin\s+(\d+)\s+(day|hour|week|month)s?\b/);
  if (inDuration) {
    const amount = parseInt(inDuration[1], 10);
    const unit = inDuration[2];
    const ms = unitToMs(unit, amount);
    if (ms > 0) return new Date(Date.now() + ms).toISOString();
  }

  // Require an event/action word near temporal markers to avoid false positives
  // on general statements like "the best framework today"
  const EVENT_CONTEXT = /\b(meeting|deadline|appointment|call|exam|interview|due|submit|deploy|release|launch|demo|standup|review|presentation)\b/;
  const hasEventContext = EVENT_CONTEXT.test(lower);

  // "tomorrow" — strong enough on its own (rarely used in timeless statements)
  if (/\btomorrow\b/.test(lower)) {
    return new Date(Date.now() + 2 * 86400000).toISOString();
  }

  // "today"/"tonight" — only with event context to avoid "popular today" false positives
  if (hasEventContext && /\btoday\b|\btonight\b/.test(lower)) {
    return new Date(Date.now() + 86400000).toISOString();
  }

  // "next/this week/month" — only with event context
  if (hasEventContext && /\b(next|this)\s+week\b/.test(lower)) {
    return new Date(Date.now() + 8 * 86400000).toISOString();
  }
  if (hasEventContext && /\b(next|this)\s+month\b/.test(lower)) {
    return new Date(Date.now() + 35 * 86400000).toISOString();
  }

  // "by/on/next [day name]" — strong signal when preceded by deadline verbs
  const dayMatch = lower.match(/\b(?:by|on|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (dayMatch) {
    const targetDay = DAY_NAMES.indexOf(dayMatch[1]);
    if (targetDay >= 0) {
      const currentDay = new Date().getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      return new Date(Date.now() + (daysUntil + 1) * 86400000).toISOString();
    }
  }

  return null;
}

function unitToMs(unit: string, amount: number): number {
  switch (unit) {
    case "hour": return amount * 3600000;
    case "day": return amount * 86400000;
    case "week": return amount * 7 * 86400000;
    case "month": return amount * 30 * 86400000;
    default: return 0;
  }
}
