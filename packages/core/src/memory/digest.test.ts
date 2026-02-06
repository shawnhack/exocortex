import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { digestTranscript, extractFacts } from "./digest.js";

function tmpFile(lines: string[]): string {
  const p = path.join(os.tmpdir(), `digest-test-${Date.now()}.jsonl`);
  fs.writeFileSync(p, lines.join("\n"), "utf-8");
  return p;
}

function assistantEntry(blocks: object[]) {
  return JSON.stringify({
    type: "assistant",
    message: { content: blocks },
  });
}

function toolUse(name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id: "t1", name, input };
}

function textBlock(text: string) {
  return { type: "text", text };
}

describe("digestTranscript", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const f of files) {
      try { fs.unlinkSync(f); } catch {}
    }
    files.length = 0;
  });

  it("parses valid transcript with mixed tool types", async () => {
    const p = tmpFile([
      assistantEntry([toolUse("Edit", { file_path: "/app/src/index.ts", old_string: "a", new_string: "b" })]),
      assistantEntry([toolUse("Bash", { command: "pnpm test" })]),
      assistantEntry([toolUse("Write", { file_path: "/app/src/utils.ts", content: "x" })]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.actions).toHaveLength(3);
    expect(result.actions[0].summary).toBe("Edit /app/src/index.ts");
    expect(result.actions[1].summary).toBe("Bash: pnpm test");
    expect(result.actions[2].summary).toBe("Write /app/src/utils.ts");
    expect(result.stats.files_changed).toBe(2);
    expect(result.stats.commands_run).toBe(1);
    expect(result.stats.tools_used).toBe(3);
  });

  it("skips read-only and exocortex tools", async () => {
    const p = tmpFile([
      assistantEntry([toolUse("Read", { file_path: "/a.ts" })]),
      assistantEntry([toolUse("Glob", { pattern: "*.ts" })]),
      assistantEntry([toolUse("Grep", { pattern: "foo" })]),
      assistantEntry([toolUse("mcp__exocortex__memory_search", { query: "test" })]),
      assistantEntry([toolUse("Edit", { file_path: "/app/src/real.ts", old_string: "x", new_string: "y" })]),
      assistantEntry([toolUse("Task", { description: "test", prompt: "test", subagent_type: "Explore" })]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].tool).toBe("Edit");
  });

  it("deduplicates consecutive same-file edits", async () => {
    const p = tmpFile([
      assistantEntry([toolUse("Edit", { file_path: "/app/src/foo.ts", old_string: "a", new_string: "b" })]),
      assistantEntry([toolUse("Edit", { file_path: "/app/src/foo.ts", old_string: "c", new_string: "d" })]),
      assistantEntry([toolUse("Edit", { file_path: "/app/src/bar.ts", old_string: "x", new_string: "y" })]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].summary).toBe("Edit /app/src/foo.ts");
    expect(result.actions[1].summary).toBe("Edit /app/src/bar.ts");
  });

  it("detects project from file paths", async () => {
    const p = tmpFile([
      assistantEntry([toolUse("Edit", { file_path: "D:/Apps/myproject/src/a.ts", old_string: "a", new_string: "b" })]),
      assistantEntry([toolUse("Edit", { file_path: "D:/Apps/myproject/src/b.ts", old_string: "c", new_string: "d" })]),
      assistantEntry([toolUse("Write", { file_path: "D:/Apps/myproject/README.md", content: "x" })]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.project).toBe("myproject");
  });

  it("handles empty transcript", async () => {
    const p = tmpFile([]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.actions).toHaveLength(0);
    expect(result.facts).toHaveLength(0);
    expect(result.project).toBeNull();
    expect(result.stats.tools_used).toBe(0);
  });

  it("handles malformed JSONL lines gracefully", async () => {
    const p = tmpFile([
      "not json at all",
      "{invalid",
      assistantEntry([toolUse("Bash", { command: "echo hello" })]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].summary).toBe("Bash: echo hello");
  });

  it("includes summary with date and stats", async () => {
    const p = tmpFile([
      assistantEntry([toolUse("Edit", { file_path: "/app/src/x.ts", old_string: "a", new_string: "b" })]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.summary).toContain("Session");
    expect(result.summary).toContain("- Edit /app/src/x.ts");
    expect(result.summary).toContain("Files changed: 1");
  });

  it("extracts facts from assistant text blocks", async () => {
    const p = tmpFile([
      assistantEntry([
        textBlock("After investigating the issue, I found that the date parser was using local timezone instead of UTC. I decided to switch to ISO 8601 format for all dates."),
        toolUse("Edit", { file_path: "/app/src/dates.ts", old_string: "a", new_string: "b" }),
      ]),
    ]);
    files.push(p);

    const result = await digestTranscript(p);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.some((f) => f.type === "discovery")).toBe(true);
    expect(result.summary).toContain("Key takeaways:");
  });
});

describe("extractFacts", () => {
  it("extracts decisions", () => {
    const texts = ["After reviewing the options, I decided to use SQLite instead of PostgreSQL for local-first storage."];
    const facts = extractFacts(texts);
    expect(facts.some((f) => f.type === "decision")).toBe(true);
    expect(facts.some((f) => f.text.includes("SQLite"))).toBe(true);
  });

  it("extracts discoveries", () => {
    const texts = ["I found that the memory leak was caused by unclosed database connections in the test suite."];
    const facts = extractFacts(texts);
    expect(facts.some((f) => f.type === "discovery")).toBe(true);
  });

  it("extracts architecture notes", () => {
    const texts = ["The approach is to use a monorepo with pnpm workspaces, where each package has its own test suite."];
    const facts = extractFacts(texts);
    expect(facts.some((f) => f.type === "architecture")).toBe(true);
  });

  it("extracts learnings", () => {
    const texts = ["Key insight: the FTS5 module in SQLite doesn't support phrase queries with wildcards by default."];
    const facts = extractFacts(texts);
    expect(facts.some((f) => f.type === "learning")).toBe(true);
  });

  it("returns empty for text without facts", () => {
    const texts = ["I will now read the file to understand the structure."];
    const facts = extractFacts(texts);
    expect(facts).toHaveLength(0);
  });

  it("deduplicates similar facts", () => {
    const texts = [
      "I decided to use SQLite for the database layer. After further review, I decided to use SQLite for the database layer too.",
    ];
    const facts = extractFacts(texts);
    const decisions = facts.filter((f) => f.type === "decision");
    expect(decisions.length).toBeLessThanOrEqual(1);
  });

  it("skips very short sentences", () => {
    const texts = ["Decided to. Found that."];
    const facts = extractFacts(texts);
    expect(facts).toHaveLength(0);
  });

  it("includes surrounding context", () => {
    const texts = ["The codebase uses TypeScript. I found that the type system caught the bug early. This saved debugging time."];
    const facts = extractFacts(texts);
    expect(facts.length).toBeGreaterThan(0);
    // Should include context sentence(s)
    if (facts.length > 0) {
      expect(facts[0].text.length).toBeGreaterThan(30);
    }
  });
});
