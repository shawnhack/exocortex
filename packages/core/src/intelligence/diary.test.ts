import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "../db/schema.js";
import { writeDiaryEntry, readDiary, listDiaryAgents } from "./diary.js";

describe("agent diary", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initializeSchema(db);
  });

  it("writes and reads diary entries", () => {
    writeDiaryEntry(db, "test-agent", "Did some work today", "debugging");
    writeDiaryEntry(db, "test-agent", "Fixed the bug", "debugging");

    const entries = readDiary(db, "test-agent");
    expect(entries).toHaveLength(2);
    const texts = entries.map(e => e.entry);
    expect(texts).toContain("Did some work today");
    expect(texts).toContain("Fixed the bug");
    expect(entries[0].agent).toBe("test-agent");
    expect(entries[0].topic).toBe("debugging");
  });

  it("filters by topic", () => {
    writeDiaryEntry(db, "agent-a", "Debug session", "debugging");
    writeDiaryEntry(db, "agent-a", "Architecture review", "architecture");

    const debug = readDiary(db, "agent-a", { topic: "debugging" });
    expect(debug).toHaveLength(1);
    expect(debug[0].entry).toContain("Debug session");
  });

  it("lists agents", () => {
    writeDiaryEntry(db, "agent-a", "Entry 1");
    writeDiaryEntry(db, "agent-a", "Entry 2");
    writeDiaryEntry(db, "agent-b", "Entry 1");

    const agents = listDiaryAgents(db);
    expect(agents).toHaveLength(2);
    expect(agents.find(a => a.agent === "agent-a")?.entries).toBe(2);
    expect(agents.find(a => a.agent === "agent-b")?.entries).toBe(1);
  });

  it("respects lastN limit", () => {
    for (let i = 0; i < 10; i++) {
      writeDiaryEntry(db, "agent", `Entry ${i}`);
    }
    const entries = readDiary(db, "agent", { lastN: 3 });
    expect(entries).toHaveLength(3);
  });
});
