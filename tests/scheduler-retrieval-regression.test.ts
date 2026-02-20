import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDb,
  getDb,
  initializeSchema,
  MemoryStore,
  setGoldenQueries,
  setSetting,
} from "@exocortex/core";
import { runScheduledRetrievalRegression } from "../packages/server/src/scheduler.ts";

describe("scheduler retrieval regression job", () => {
  it("runs scheduled retrieval regression and respects enabled toggle", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-scheduler-"));
    const dbPath = path.join(tempDir, "test.db");

    process.env.EXOCORTEX_DB_PATH = dbPath;
    closeDb();
    const db = getDb();
    initializeSchema(db);

    const store = new MemoryStore(db);
    await store.create({
      content: "Scheduler retrieval regression seed memory",
      tags: ["retrieval"],
    });
    setGoldenQueries(db, ["scheduler retrieval regression"]);

    const first = await runScheduledRetrievalRegression();
    expect(first.status).toBe("ran");
    if (first.status === "ran") {
      expect(first.result.ran).toBe(1);
      expect(first.result.run_id).toBeTruthy();
    }

    setSetting(db, "retrieval_regression.enabled", "false");
    const disabled = await runScheduledRetrievalRegression();
    expect(disabled.status).toBe("disabled");

    closeDb();
    delete process.env.EXOCORTEX_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

