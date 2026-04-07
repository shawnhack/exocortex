/**
 * Agent Diary — per-agent session journaling.
 *
 * Each agent records structured entries after sessions: what happened,
 * what was learned, what matters. Entries are queryable by agent name,
 * topic, and time range.
 */

import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiaryEntry {
  id: string;
  agent: string;
  entry: string;
  topic: string;
  created_at: string;
}

export interface DiaryWriteResult {
  id: string;
  agent: string;
  topic: string;
}

// ---------------------------------------------------------------------------
// Schema — creates table if not exists
// ---------------------------------------------------------------------------

export function ensureDiarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_diary (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      agent TEXT NOT NULL,
      entry TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_diary_agent ON agent_diary(agent);
    CREATE INDEX IF NOT EXISTS idx_diary_agent_topic ON agent_diary(agent, topic);
    CREATE INDEX IF NOT EXISTS idx_diary_created ON agent_diary(created_at);
  `);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeDiaryEntry(
  db: DatabaseSync,
  agent: string,
  entry: string,
  topic: string = "general",
): DiaryWriteResult {
  ensureDiarySchema(db);

  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  db.prepare(
    "INSERT INTO agent_diary (id, agent, entry, topic) VALUES (?, ?, ?, ?)"
  ).run(id, agent, entry, topic);

  return { id, agent, topic };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function readDiary(
  db: DatabaseSync,
  agent: string,
  options: { lastN?: number; topic?: string; after?: string; before?: string } = {},
): DiaryEntry[] {
  ensureDiarySchema(db);

  const { lastN = 10, topic, after, before } = options;
  const conditions = ["agent = ?"];
  const params: unknown[] = [agent];

  if (topic) {
    conditions.push("topic = ?");
    params.push(topic);
  }
  if (after) {
    conditions.push("created_at >= ?");
    params.push(after);
  }
  if (before) {
    conditions.push("created_at <= ?");
    params.push(before);
  }

  params.push(lastN);

  return db
    .prepare(
      `SELECT id, agent, entry, topic, created_at
       FROM agent_diary
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...(params as string[])) as unknown as DiaryEntry[];
}

// ---------------------------------------------------------------------------
// List agents with diary entries
// ---------------------------------------------------------------------------

export function listDiaryAgents(db: DatabaseSync): Array<{ agent: string; entries: number; lastEntry: string }> {
  ensureDiarySchema(db);

  return db
    .prepare(
      `SELECT agent, COUNT(*) as entries, MAX(created_at) as lastEntry
       FROM agent_diary
       GROUP BY agent
       ORDER BY lastEntry DESC`
    )
    .all() as unknown as Array<{ agent: string; entries: number; lastEntry: string }>;
}
