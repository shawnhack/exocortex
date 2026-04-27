import type { EmbeddingProvider } from "./types.js";

// Pipelines from @huggingface/transformers — keyed by model name so that
// multiple providers with different models can coexist in the same process
// (needed for A/B tests, model migration scripts, and any future hybrid
// embedding setup). Previously this was a single nullable singleton, which
// silently returned the FIRST loaded model's output for any subsequent
// provider regardless of what model was requested — a latent bug that
// produced false A/B test results when swapping models in-process.
//
// Cache is keyed by model name. Each unique model loads once; subsequent
// requests for the same model reuse the cached pipeline.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipelineCache = new Map<string, Promise<any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPipeline(model: string): Promise<any> {
  const cached = pipelineCache.get(model);
  if (cached) return cached;

  const loadPromise = (async () => {
    const { pipeline: createPipeline, env } = await import(
      "@huggingface/transformers"
    );

    // Use local cache directory
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    env.cacheDir = process.env.EXOCORTEX_MODEL_DIR ?? join(homedir(), ".exocortex", "models");

    return createPipeline("feature-extraction", model, {
      dtype: "fp32",
    });
  })();

  pipelineCache.set(model, loadPromise);
  try {
    return await loadPromise;
  } catch (err) {
    // Don't cache failed loads — let next call retry from scratch
    pipelineCache.delete(model);
    throw err;
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private dims: number;

  constructor(model = "Xenova/bge-small-en-v1.5", dimensions = 384) {
    this.model = model;
    this.dims = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await getPipeline(this.model);
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0])];

    // Native batch embedding — pipeline accepts string[] for parallel processing
    const pipe = await getPipeline(this.model);
    const output = await pipe(texts, { pooling: "mean", normalize: true });

    // Output.data contains all embeddings concatenated; split by dimension count
    const dims = this.dims;
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(new Float32Array(output.data.slice(i * dims, (i + 1) * dims)));
    }
    return results;
  }

  dimensions(): number {
    return this.dims;
  }
}
