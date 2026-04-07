/**
 * Embedding model catalog — available models with their characteristics.
 *
 * All models run locally via @huggingface/transformers (ONNX runtime).
 * No API calls, no cloud dependency.
 */

export interface EmbeddingModelInfo {
  /** HuggingFace model ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Output dimensions */
  dimensions: number;
  /** Approximate model size in MB */
  sizeMb: number;
  /** Approximate RAM usage in MB */
  ramMb: number;
  /** Relative quality (1-5, higher = better semantic understanding) */
  quality: number;
  /** Relative speed (1-5, higher = faster) */
  speed: number;
  /** Best for */
  bestFor: string;
}

export const EMBEDDING_MODELS: EmbeddingModelInfo[] = [
  {
    id: "Xenova/bge-small-en-v1.5",
    name: "BGE Small (default)",
    dimensions: 384,
    sizeMb: 33,
    ramMb: 90,
    quality: 3,
    speed: 5,
    bestFor: "General use — fast, low memory, good quality",
  },
  {
    id: "Xenova/all-MiniLM-L6-v2",
    name: "MiniLM L6",
    dimensions: 384,
    sizeMb: 23,
    ramMb: 80,
    quality: 3,
    speed: 5,
    bestFor: "Lightweight — smallest model, fastest inference",
  },
  {
    id: "Xenova/bge-base-en-v1.5",
    name: "BGE Base",
    dimensions: 768,
    sizeMb: 110,
    ramMb: 200,
    quality: 4,
    speed: 3,
    bestFor: "Higher quality — better semantic matching, more RAM",
  },
  {
    id: "Xenova/all-MiniLM-L12-v2",
    name: "MiniLM L12",
    dimensions: 384,
    sizeMb: 33,
    ramMb: 100,
    quality: 3,
    speed: 4,
    bestFor: "Balanced — deeper than L6, same dimensions",
  },
  {
    id: "Xenova/bge-large-en-v1.5",
    name: "BGE Large",
    dimensions: 1024,
    sizeMb: 335,
    ramMb: 500,
    quality: 5,
    speed: 1,
    bestFor: "Highest quality — best semantic understanding, heavy",
  },
  {
    id: "Xenova/e5-small-v2",
    name: "E5 Small",
    dimensions: 384,
    sizeMb: 33,
    ramMb: 90,
    quality: 3,
    speed: 5,
    bestFor: "Alternative to BGE Small — different training data",
  },
];

export const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

export function getModelInfo(modelId: string): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS.find((m) => m.id === modelId);
}

export function getDefaultModel(): EmbeddingModelInfo {
  return EMBEDDING_MODELS[0];
}
