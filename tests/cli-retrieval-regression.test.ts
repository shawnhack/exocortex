import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getDb,
  closeDb,
  initializeSchema,
  getLatestRetrievalRegressionRunId,
  MemoryStore,
  setEmbeddingProvider,
  resetEmbeddingProvider,
} from "@exocortex/core";

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

function runCli(args: string[], env: Record<string, string>) {
  const mockEmbeddings = pathToFileURL(
    path.resolve("tests/helpers/mock-embeddings.ts")
  ).href;
  const cliEntry = path.resolve("packages/cli/src/index.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", mockEmbeddings, cliEntry, ...args],
    {
      cwd: path.resolve("."),
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 30_000,
    }
  );
}

function parseJsonOutput(stdout: string): any {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return JSON.parse(trimmed.slice(start, end + 1));
}

describe("CLI retrieval regression", () => {
  it("supports run/compare and fail-on-alert gating", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-cli-reg-"));
    const dbPath = path.join(tempDir, "test.db");
    const env = { EXOCORTEX_DB_PATH: dbPath };

    setEmbeddingProvider(mockProvider);
    const db = getDb(dbPath);
    initializeSchema(db);

    try {
      const store = new MemoryStore(db);
      await store.create({
        content: "alpha routing architecture memory",
        content_type: "note",
        source: "import",
        tags: ["project", "alpha"],
      });
      await store.create({
        content: "alpha scratch note for fts range",
        content_type: "note",
        source: "import",
        tags: ["project"],
      });

      const first = runCli(
        [
          "retrieval-regression",
          "--set-queries",
          "alpha routing architecture",
          "--limit",
          "1",
          "--min-overlap",
          "1",
          "--max-rank-shift",
          "0",
          "--json",
        ],
        env
      );
      expect(first.status).toBe(0);
      const firstJson = parseJsonOutput(first.stdout);
      expect(firstJson).toBeTruthy();
      expect(firstJson.alerts).toBe(0);

      const runId = getLatestRetrievalRegressionRunId(db);
      expect(runId).toBeTruthy();

      const compareOk = runCli(
        [
          "retrieval-regression",
          "--compare-against",
          runId!,
          "--limit",
          "1",
          "--min-overlap",
          "1",
          "--max-rank-shift",
          "0",
          "--fail-on-alert",
        ],
        env
      );
      expect(compareOk.status).toBe(0);

      const compareFail = runCli(
        [
          "retrieval-regression",
          "--compare-against",
          runId!,
          "--limit",
          "1",
          "--min-overlap",
          "1.1",
          "--max-rank-shift",
          "0",
          "--fail-on-alert",
        ],
        env
      );
      expect(compareFail.status).toBe(1);
    } finally {
      closeDb(dbPath);
      resetEmbeddingProvider();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
