import { setEmbeddingProvider } from "@exocortex/core";

const mockProvider = {
  async embed(text: string): Promise<Float32Array> {
    const arr = new Float32Array(16);
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      arr[lower.charCodeAt(i) % arr.length] += 1;
    }
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return arr;
  },
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => mockProvider.embed(t)));
  },
  dimensions(): number {
    return 16;
  },
};

setEmbeddingProvider(mockProvider);
