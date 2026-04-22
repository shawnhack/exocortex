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

    try {
      tokenizerInstance = await AutoTokenizer.from_pretrained(modelName);
      modelInstance = await AutoModelForSequenceClassification.from_pretrained(
        modelName,
        { dtype: "fp32" },
      );
    } catch (err) {
      // Partial-load failure (network mid-download, OOM on model weights) can
      // leave tokenizer set but model null. Reset both so the next caller gets
      // a clean retry attempt rather than reusing a half-loaded state.
      tokenizerInstance = null;
      modelInstance = null;
      console.warn(
        `LocalReranker: failed to load model "${modelName}": ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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
    // Some cross-encoders emit [batch, 2] softmax-style; take positive-class logit.
    // Anything else is an unsupported model — return neutral scores rather than
    // silently corrupt the ranking by reading from wrong offsets.
    const logits = outputs.logits.data as Float32Array | number[];
    const stride = logits.length / candidates.length;
    if (!Number.isInteger(stride) || stride < 1 || stride > 2) {
      console.warn(
        `LocalReranker: unexpected logits shape (length=${logits.length}, batch=${candidates.length}, stride=${stride}). ` +
          `Expected stride 1 (regression) or 2 (binary softmax). Returning neutral 0.5 scores.`,
      );
      return candidates.map(() => 0.5);
    }
    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const raw = stride === 1 ? logits[i] : logits[i * 2 + 1];
      scores.push(sigmoid(Number(raw)));
    }
    return scores;
  }
}

/**
 * Factory that returns a singleton cross-encoder instance.
 *
 * Note: the model name is locked in on first call and ignored on
 * subsequent calls — the underlying tokenizer/model singletons in
 * `ensureLoaded` are also process-scoped, so requesting a different
 * model after the first load wouldn't take effect anyway. Warn rather
 * than silently use the wrong model.
 */
let defaultRerankerInstance: LocalReranker | null = null;
let defaultRerankerModel: string | undefined = undefined;

export function getDefaultReranker(modelName?: string): LocalReranker {
  if (!defaultRerankerInstance) {
    defaultRerankerInstance = new LocalReranker(modelName);
    defaultRerankerModel = modelName;
  } else if (modelName && modelName !== defaultRerankerModel) {
    console.warn(
      `getDefaultReranker: requested model "${modelName}" but singleton already initialized with "${defaultRerankerModel ?? "(default)"}". Returning existing instance.`,
    );
  }
  return defaultRerankerInstance;
}
