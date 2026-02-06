import type { EmbeddingProvider } from "./types.js";
import { LocalEmbeddingProvider } from "./local.js";

let provider: EmbeddingProvider | null = null;
let initPromise: Promise<EmbeddingProvider> | null = null;

export async function getEmbeddingProvider(
  model?: string,
  dimensions?: number
): Promise<EmbeddingProvider> {
  if (provider) return provider;

  if (!initPromise) {
    initPromise = (async () => {
      const p = new LocalEmbeddingProvider(model, dimensions);
      // Warm up: run a dummy embed to trigger model download/load
      await p.embed("warmup");
      provider = p;
      return p;
    })();
  }

  return initPromise;
}

export function setEmbeddingProvider(p: EmbeddingProvider): void {
  provider = p;
  initPromise = null;
}

export function resetEmbeddingProvider(): void {
  provider = null;
  initPromise = null;
}
