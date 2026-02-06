import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "@exocortex/core";

afterEach(() => {
  delete process.env.EXOCORTEX_DB_PATH;
  closeDb();
});

describe("db connection", () => {
  it("returns distinct instances for distinct database paths", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-db-"));
    const dbPathA = path.join(baseDir, "a.db");
    const dbPathB = path.join(baseDir, "b.db");

    const dbA = getDb(dbPathA);
    const dbB = getDb(dbPathB);

    expect(dbA).not.toBe(dbB);
  });

  it("uses EXOCORTEX_DB_PATH for default getDb()", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-db-env-"));
    const envPath = path.join(baseDir, "env.db");
    process.env.EXOCORTEX_DB_PATH = envPath;

    const dbFromEnv = getDb();
    const dbExplicit = getDb(envPath);
    expect(dbFromEnv).toBe(dbExplicit);
  });

  it("closeDb(path) closes only that path", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "exo-db-close-"));
    const dbPathA = path.join(baseDir, "a.db");
    const dbPathB = path.join(baseDir, "b.db");

    const dbA = getDb(dbPathA);
    const dbB = getDb(dbPathB);

    closeDb(dbPathA);

    const reopenedA = getDb(dbPathA);
    const stillB = getDb(dbPathB);

    const checkA = reopenedA.prepare("SELECT 1 as ok").get() as { ok: number };
    const checkB = stillB.prepare("SELECT 1 as ok").get() as { ok: number };

    expect(checkA.ok).toBe(1);
    expect(checkB.ok).toBe(1);
    expect(stillB).toBe(dbB);
  });
});
