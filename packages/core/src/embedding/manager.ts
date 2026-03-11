import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "./types.js";
import { LocalEmbeddingProvider } from "./local.js";

const CACHE_MAX = 256;

/** LRU cache wrapper for embedding providers — avoids recomputing embeddings for repeated queries */
class CachedEmbeddingProvider implements EmbeddingProvider {
  private inner: EmbeddingProvider;
  private cache = new Map<string, Float32Array>();

  constructor(inner: EmbeddingProvider) {
    this.inner = inner;
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached) {
      // Move to end (most-recently-used)
      this.cache.delete(text);
      this.cache.set(text, cached);
      return cached;
    }
    const result = await this.inner.embed(text);
    this.cache.set(text, result);
    if (this.cache.size > CACHE_MAX) {
      // Evict oldest entry
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Separate cache hits from misses to batch-embed only uncached texts
    const results = new Array<Float32Array>(texts.length);
    const missIndices: number[] = [];
    const missTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        this.cache.delete(texts[i]);
        this.cache.set(texts[i], cached);
        results[i] = cached;
      } else {
        missIndices.push(i);
        missTexts.push(texts[i]);
      }
    }

    if (missTexts.length > 0) {
      const embedded = await this.inner.embedBatch(missTexts);
      for (let j = 0; j < missIndices.length; j++) {
        const text = missTexts[j];
        const vec = embedded[j];
        results[missIndices[j]] = vec;
        this.cache.set(text, vec);
        if (this.cache.size > CACHE_MAX) {
          const oldest = this.cache.keys().next().value!;
          this.cache.delete(oldest);
        }
      }
    }

    return results;
  }

  dimensions(): number {
    return this.inner.dimensions();
  }
}

let provider: EmbeddingProvider | null = null;
let initPromise: Promise<EmbeddingProvider> | null = null;

export async function getEmbeddingProvider(
  model?: string,
  dimensions?: number,
  db?: DatabaseSync
): Promise<EmbeddingProvider> {
  if (provider) return provider;

  if (!initPromise) {
    initPromise = (async () => {
      // Resolve model: explicit arg > db setting > constructor default
      let resolvedModel = model;
      if (!resolvedModel && db) {
        try {
          const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("embedding.model") as
            | { value: string }
            | undefined;
          if (row?.value) resolvedModel = row.value;
        } catch {
          // Ignore — fall through to constructor default
        }
      }
      // Resolve dimensions: explicit arg > db setting > constructor default
      let resolvedDims = dimensions;
      if (!resolvedDims && db) {
        try {
          const dimRow = db.prepare("SELECT value FROM settings WHERE key = ?").get("embedding.dimensions") as
            | { value: string }
            | undefined;
          if (dimRow?.value) resolvedDims = parseInt(dimRow.value, 10);
        } catch {
          // Ignore
        }
      }
      const p = new LocalEmbeddingProvider(resolvedModel, resolvedDims);
      // Warm up: run a dummy embed to trigger model download/load
      console.log(`[exocortex] Loading embedding model${resolvedModel ? ` (${resolvedModel})` : ""}... this may take a moment on first run.`);
      await p.embed("warmup");
      console.log("[exocortex] Embedding model ready.");
      provider = new CachedEmbeddingProvider(p);
      return provider;
    })().catch((err) => {
      // Reset so next call retries instead of returning a rejected promise forever
      initPromise = null;
      throw err;
    });
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
