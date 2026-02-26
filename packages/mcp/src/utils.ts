export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function packByTokenBudget<T>(
  items: T[],
  maxTokens: number,
  formatFn: (item: T) => string
): { packed: T[]; formatted: string[]; totalTokens: number } {
  const packed: T[] = [];
  const formatted: string[] = [];
  let totalTokens = 0;

  for (const item of items) {
    const text = formatFn(item);
    const tokens = estimateTokens(text);

    if (packed.length > 0 && totalTokens + tokens > maxTokens) break;

    // Always include at least one result
    packed.push(item);
    formatted.push(text);
    totalTokens += tokens;
  }

  return { packed, formatted, totalTokens };
}

export function smartPreview(content: string, query: string, maxLen = 200): string {
  const sentences = content.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  if (sentences.length === 0) return content.substring(0, maxLen);

  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  );

  if (queryWords.size === 0) {
    const first = sentences[0];
    return first.length > maxLen ? first.substring(0, maxLen - 3) + "..." : first;
  }

  let bestScore = -1;
  let bestSentence = sentences[0];

  for (const sentence of sentences) {
    const words = sentence.toLowerCase().split(/\s+/);
    const overlap = words.filter((w) => queryWords.has(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestSentence = sentence;
    }
  }

  return bestSentence.length > maxLen
    ? bestSentence.substring(0, maxLen - 3) + "..."
    : bestSentence;
}
