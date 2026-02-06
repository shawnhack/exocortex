import type { EmbeddingProvider } from "./types.js";

let pipeline: any = null;

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

  constructor(model = "Xenova/all-MiniLM-L6-v2", dimensions = 384) {
    this.model = model;
    this.dims = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await getPipeline(this.model);
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  dimensions(): number {
    return this.dims;
  }
}
