const PALETTE = [
  "#22d3ee", "#06b6d4", "#34d399", "#fbbf24", "#f472b6",
  "#fb923c", "#38bdf8", "#67e8f9", "#4ade80", "#f87171",
];

export function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
