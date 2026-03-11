/** Tier dot/bar colors — simple hex values */
export const TIER_COLORS: Record<string, string> = {
  working: "#8080a0",
  episodic: "#fbbf24",
  semantic: "#a78bfa",
  procedural: "#34d399",
  reference: "#38bdf8",
};

/** Tier badge colors — color + translucent background */
export const TIER_BADGE_COLORS: Record<string, { color: string; bg: string }> = {
  reference: { color: "#38bdf8", bg: "rgba(56, 189, 248, 0.15)" },
  semantic: { color: "#a78bfa", bg: "rgba(167, 139, 250, 0.15)" },
  procedural: { color: "#34d399", bg: "rgba(52, 211, 153, 0.15)" },
  episodic: { color: "#fbbf24", bg: "rgba(251, 191, 36, 0.15)" },
  working: { color: "#8080a0", bg: "rgba(128, 128, 160, 0.1)" },
};

/** Semantic tag colors for decision/discovery/architecture/learning */
export const FACT_TAG_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  decision: { color: "#38bdf8", bg: "rgba(56, 189, 248, 0.1)", border: "rgba(56, 189, 248, 0.2)" },
  discovery: { color: "#22d3ee", bg: "rgba(34, 211, 238, 0.1)", border: "rgba(34, 211, 238, 0.2)" },
  architecture: { color: "#34d399", bg: "rgba(52, 211, 153, 0.1)", border: "rgba(52, 211, 153, 0.2)" },
  learning: { color: "#fbbf24", bg: "rgba(251, 191, 36, 0.1)", border: "rgba(251, 191, 36, 0.2)" },
};
