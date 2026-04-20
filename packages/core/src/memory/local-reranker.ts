import type { RerankerProvider } from "./reranker.js";

/**
 * Local cross-encoder reranker using @huggingface/transformers.
 *
 * Cross-encoders score (query, doc) pairs directly — much more accurate than
 * bi-encoder cosine similarity because the model attends over both at once.
 *
 * Used as a second-stage reranker: hybrid retrieval produces top-N candidates,
 * the cross-encoder reranks them into a final top-K. Adds ~30-80ms per call
 * for typical reranking of 10-20 candidates (CPU, fp32).
 *
 * Default model: Xenova/bge-reranker-base — ~280MB, well-tested cross-encoder.
 */

// Lazy-loaded singletons — model weights are heavy, load once per process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenizerInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelInstance: any = null;
let loadingPromise: Promise<void> | null = null;

async function ensureLoaded(modelName: string): Promise<void> {
  if (tokenizerInstance && modelInstance) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } =
      await import("@huggingface/transformers");

    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    env.cacheDir =
      process.env.EXOCORTEX_MODEL_DIR ??
      join(homedir(), ".exocortex", "models");

    tokenizerInstance = await AutoTokenizer.from_pretrained(modelName);
    modelInstance = await AutoModelForSequenceClassification.from_pretrained(
      modelName,
      { dtype: "fp32" },
    );
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class LocalReranker implements RerankerProvider {
  private model: string;
  private maxLength: number;

  constructor(
    model = "Xenova/bge-reranker-base",
    maxLength = 512,
  ) {
    this.model = model;
    this.maxLength = maxLength;
  }

  async rerank(query: string, candidates: string[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    await ensureLoaded(this.model);

    // Build query-doc pairs. Tokenizer handles pair encoding via text_pair.
    const queries = candidates.map(() => query);

    const inputs = tokenizerInstance(queries, {
      text_pair: candidates,
      padding: true,
      truncation: true,
      max_length: this.maxLength,
      return_tensors: "pt",
    });

    const outputs = await modelInstance(inputs);

    // logits shape: [batch, 1] for regression-style rerankers (BGE, etc.)
    // Flatten and sigmoid-normalize to 0-1.
    const logits = outputs.logits.data as Float32Array | number[];
    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      // Some cross-encoders emit [batch, 2] softmax-style; take positive-class logit.
      // Detect via logits length vs batch size.
      const raw =
        logits.length === candidates.length
          ? logits[i]
          : logits[i * 2 + 1]; // positive class in binary softmax models
      scores.push(sigmoid(Number(raw)));
    }
    return scores;
  }
}

/**
 * Factory that returns a singleton cross-encoder instance or null if disabled.
 * Callers should invoke this once at startup and pass the result into search.
 */
let defaultRerankerInstance: LocalReranker | null = null;

export function getDefaultReranker(modelName?: string): LocalReranker {
  if (!defaultRerankerInstance) {
    defaultRerankerInstance = new LocalReranker(modelName);
  }
  return defaultRerankerInstance;
}
