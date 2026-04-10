import { Hono } from "hono";
import { getDb, readDiary, listDiaryAgents, ensureDiarySchema } from "@exocortex/core";

const diary = new Hono();

/**
 * GET /api/diary/agents — List agents with diary entries.
 */
diary.get("/api/diary/agents", (c) => {
  const db = getDb();
  ensureDiarySchema(db);
  const agents = listDiaryAgents(db);
  return c.json({ agents });
});

/**
 * GET /api/diary/:agent — Read diary entries for an agent.
 */
diary.get("/api/diary/:agent", (c) => {
  const db = getDb();
  ensureDiarySchema(db);
  const agent = c.req.param("agent");
  const topic = c.req.query("topic") ?? undefined;
  const after = c.req.query("after") ?? undefined;
  const before = c.req.query("before") ?? undefined;
  const lastN = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 20;

  const entries = readDiary(db, agent, { lastN, topic, after, before });
  return c.json({ entries, count: entries.length });
});

export default diary;
