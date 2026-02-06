export interface ChunkOptions {
  targetSize?: number;
}

/**
 * Split text into embedding-friendly chunks.
 * Strategy: split at paragraph boundaries first, then sentence boundaries.
 * Each chunk will be roughly targetSize characters.
 */
export function splitIntoChunks(
  text: string,
  opts: ChunkOptions = {}
): string[] {
  const targetSize = opts.targetSize ?? 500;

  if (text.length <= targetSize) return [text];

  // Split into paragraphs first
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // If adding this paragraph would exceed target and we already have content
    if (current.length > 0 && current.length + para.length + 2 > targetSize) {
      chunks.push(current.trim());
      current = "";
    }

    // If a single paragraph is too long, split at sentence boundaries
    if (para.length > targetSize) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }

      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (
          current.length > 0 &&
          current.length + sentence.length + 1 > targetSize
        ) {
          chunks.push(current.trim());
          current = "";
        }
        current += (current.length > 0 ? " " : "") + sentence;
      }
    } else {
      current += (current.length > 0 ? "\n\n" : "") + para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}
