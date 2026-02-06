export function parseUTC(dateStr: string): Date {
  const normalized = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
  return new Date(normalized);
}

export function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = parseUTC(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
