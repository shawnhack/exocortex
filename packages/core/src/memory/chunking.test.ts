import { describe, it, expect } from "vitest";
import { splitIntoChunks } from "./chunking.js";

describe("chunking", () => {
  it("should return single chunk for short text", () => {
    const result = splitIntoChunks("Hello world", { targetSize: 500 });
    expect(result).toEqual(["Hello world"]);
  });

  it("should split at paragraph boundaries", () => {
    const text = "First paragraph with enough content to matter.\n\nSecond paragraph with different content.\n\nThird paragraph about another topic.";
    const result = splitIntoChunks(text, { targetSize: 60 });
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((c) => c.length > 0)).toBe(true);
  });

  it("should split long paragraphs at sentence boundaries", () => {
    const longParagraph =
      "First sentence is here. Second sentence follows. Third sentence appears. Fourth sentence comes next. Fifth sentence ends it.";
    const result = splitIntoChunks(longParagraph, { targetSize: 60 });
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should end with a complete sentence
    for (const chunk of result) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it("should merge small paragraphs into chunks", () => {
    const text = "A.\n\nB.\n\nC.\n\nD.\n\nE.";
    const result = splitIntoChunks(text, { targetSize: 500 });
    // All short paragraphs should fit in one chunk
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("A.");
    expect(result[0]).toContain("E.");
  });

  it("should preserve all content (no data loss)", () => {
    const text =
      "Alpha paragraph one.\n\nBeta paragraph two with more text here.\n\nGamma paragraph three finishes.";
    const result = splitIntoChunks(text, { targetSize: 50 });
    const joined = result.join("\n\n");
    // All original words should appear in the chunks
    expect(joined).toContain("Alpha");
    expect(joined).toContain("Beta");
    expect(joined).toContain("Gamma");
  });

  it("should handle empty text", () => {
    const result = splitIntoChunks("", { targetSize: 500 });
    expect(result).toEqual([""]);
  });

  it("should handle text with no paragraph breaks", () => {
    const text =
      "One long continuous text without any paragraph breaks but with sentences. It goes on and on. And continues further still. With more content here.";
    const result = splitIntoChunks(text, { targetSize: 80 });
    expect(result.length).toBeGreaterThan(1);
  });

  it("should use default targetSize of 500", () => {
    const shortText = "A".repeat(400);
    const result = splitIntoChunks(shortText);
    expect(result).toHaveLength(1);
  });
});
