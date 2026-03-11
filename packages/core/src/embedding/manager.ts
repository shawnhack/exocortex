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
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
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
