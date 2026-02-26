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
      const p = new LocalEmbeddingProvider(resolvedModel, dimensions);
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
