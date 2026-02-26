import { describe, it, expect } from "vitest";
import { autoGenerateTags } from "./auto-tags.js";

describe("autoGenerateTags", () => {
  it("extracts tech keywords", () => {
    const tags = autoGenerateTags("We migrated from webpack to vite for the React project");
    expect(tags).toContain("webpack");
    expect(tags).toContain("vite");
    expect(tags).toContain("react");
  });

  it("extracts topic patterns", () => {
    const tags = autoGenerateTags("Decided to use SQLite instead of Postgres for the local database");
    expect(tags).toContain("sqlite");
    expect(tags).toContain("postgres");
    expect(tags).toContain("decision");
  });

  it("does not extract removed over-saturated topics (bug, architecture, config)", () => {
    expect(autoGenerateTags("Fixed a crash in the login handler")).not.toContain("bug");
    expect(autoGenerateTags("The architecture uses a layered pattern")).not.toContain("architecture");
    expect(autoGenerateTags("Updated the configuration settings")).not.toContain("config");
  });

  it("extracts kebab-case project names", () => {
    const tags = autoGenerateTags("The my-cool-project package uses custom-logger for output");
    expect(tags).toContain("my-cool-project");
    expect(tags).toContain("custom-logger");
  });

  it("filters blocklisted project names", () => {
    const tags = autoGenerateTags("This built-in real-time feature is up-to-date");
    expect(tags).not.toContain("built-in");
    expect(tags).not.toContain("real-time");
    expect(tags).not.toContain("up-to-date");
  });

  it("filters expanded blocklist entries", () => {
    const tags = autoGenerateTags("A read-only key-value store with hot-reload and type-safe access");
    expect(tags).not.toContain("read-only");
    expect(tags).not.toContain("key-value");
    expect(tags).not.toContain("hot-reload");
    expect(tags).not.toContain("type-safe");
  });

  it("returns at most 3 tags", () => {
    const tags = autoGenerateTags(
      "Using react, typescript, vite, tailwind, graphql, docker, kubernetes and rust for our deploy pipeline"
    );
    expect(tags.length).toBeLessThanOrEqual(3);
  });

  it("returns empty array for content with no matches", () => {
    const tags = autoGenerateTags("The weather is nice today");
    expect(tags).toEqual([]);
  });

  it("extracts lesson topic", () => {
    const tags = autoGenerateTags("Learned that caching improves latency significantly");
    expect(tags).toContain("lesson");
  });

  it("extracts performance topic", () => {
    const tags = autoGenerateTags("Optimized the query to reduce latency by 50%");
    expect(tags).toContain("performance");
  });

  it("extracts security topic", () => {
    const tags = autoGenerateTags("Found a CSRF vulnerability in the authentication flow");
    expect(tags).toContain("security");
  });

  it("handles empty string", () => {
    const tags = autoGenerateTags("");
    expect(tags).toEqual([]);
  });
});
