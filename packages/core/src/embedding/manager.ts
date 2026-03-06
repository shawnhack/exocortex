import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "./types.js";
import { LocalEmbeddingProvider } from "./local.js";

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
      console.error(`[exocortex] Loading embedding model${resolvedModel ? ` (${resolvedModel})` : ""}... this may take a moment on first run.`);
      await p.embed("warmup");
      console.error("[exocortex] Embedding model ready.");
      provider = p;
      return p;
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
