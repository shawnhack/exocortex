import type { EmbeddingProvider } from "./types.js";

// Pipeline from @huggingface/transformers — typed as `any` because the
// FeatureExtractionPipeline union is too broad to narrow without importing
// the full (heavy) module at parse time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipeline: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPipeline(model: string): Promise<any> {
  if (pipeline) return pipeline;

  const { pipeline: createPipeline, env } = await import(
    "@huggingface/transformers"
  );

  // Use local cache directory
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  env.cacheDir = process.env.EXOCORTEX_MODEL_DIR ?? join(homedir(), ".exocortex", "models");

  pipeline = await createPipeline("feature-extraction", model, {
    dtype: "fp32",
  });

  return pipeline;
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
