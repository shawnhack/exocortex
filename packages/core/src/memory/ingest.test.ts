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
      "Content of section one with enough body text to pass the minimum threshold easily.",
      "",
      "## Section Two",
      "Content of section two with enough body text to pass the minimum threshold easily.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("## Section One");
    expect(sections[0]).toContain("Content of section one");
    expect(sections[1]).toContain("## Section Two");
    expect(sections[1]).toContain("Content of section two");
  });

  it("should include preamble before first header as its own section", () => {
    const content = [
      "# Title",
      "Some intro text here that is long enough to pass the body threshold on its own.",
      "",
      "## First Section",
      "Section content here that is also long enough to pass the body threshold on its own.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("# Title");
    expect(sections[0]).toContain("Some intro text");
    expect(sections[1]).toContain("## First Section");
  });

  it("should merge short sections into the next when they come first", () => {
    const content = [
      "## Empty",
      "",
      "## Real Section",
      "This section has enough content to keep and pass the fifty character minimum body threshold.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("## Empty");
    expect(sections[0]).toContain("## Real Section");
  });

  it("should merge short sections into the previous section", () => {
    const content = [
      "## First Section",
      "This section has enough content to keep and pass the fifty character minimum body threshold easily.",
      "",
      "## Tiny",
      "#### 3.",
      "",
      "## Last Section",
      "This section also has enough content to keep and pass the fifty character minimum body threshold.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("## First Section");
    expect(sections[0]).toContain("## Tiny");
    expect(sections[0]).toContain("#### 3.");
    expect(sections[1]).toContain("## Last Section");
  });

  it("should merge sections that are only headers with no body text", () => {
    const content = [
      "## Header Only",
      "### Sub-header",
      "#### Sub-sub-header",
      "",
      "## Real Section",
      "This section has enough real body content to stand alone and pass the threshold.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("## Header Only");
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
      "This is the architecture overview with enough detail to pass the threshold.",
      "It has multiple lines of content that describe the system design thoroughly.",
      "",
      "## Stack",
      "The technology stack includes TypeScript for type safety and SQLite for storage.",
      "We also use React for the frontend and Node.js for the backend runtime environment.",
      "",
      "## Commands",
      "Run pnpm test to execute the test suite and pnpm build to compile the TypeScript.",
    ].join("\n");

    const sections = splitMarkdownSections(content);
    expect(sections).toHaveLength(3);
  });
});
