import { describe, it, expect } from "vitest";
import { splitMarkdownSections } from "./ingest.js";

describe("splitMarkdownSections", () => {
  it("should return entire content as one section when no ## headers", () => {
    const content = "This is a paragraph.\n\nAnother paragraph here.";
    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toBe(content);
  });

  it("should split on ## headers", () => {
    const content = [
      "## Section One",
      "Content of section one.",
      "",
      "## Section Two",
      "Content of section two.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("## Section One");
    expect(sections[0]).toContain("Content of section one.");
    expect(sections[1]).toContain("## Section Two");
    expect(sections[1]).toContain("Content of section two.");
  });

  it("should include preamble before first header as its own section", () => {
    const content = [
      "# Title",
      "Some intro text here.",
      "",
      "## First Section",
      "Section content here.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("# Title");
    expect(sections[0]).toContain("Some intro text");
    expect(sections[1]).toContain("## First Section");
  });

  it("should skip empty sections (< 10 chars)", () => {
    const content = [
      "## Empty",
      "",
      "## Real Section",
      "This section has enough content to keep.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    // "## Empty" alone is 8 chars — skipped
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("## Real Section");
  });

  it("should return empty array for empty content", () => {
    expect(splitMarkdownSections("")).toHaveLength(0);
  });

  it("should return empty array for whitespace-only content", () => {
    expect(splitMarkdownSections("   \n  \n  ")).toHaveLength(0);
  });

  it("should not split on ### headers", () => {
    const content = [
      "## Main Section",
      "Some content.",
      "### Subsection",
      "More content here.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("### Subsection");
  });

  it("should handle multiple sections with varied content", () => {
    const content = [
      "## Architecture",
      "This is the architecture overview.",
      "It has multiple lines.",
      "",
      "## Stack",
      "- TypeScript",
      "- SQLite",
      "- React",
      "",
      "## Commands",
      "Run `pnpm test` to test.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(3);
  });
});
