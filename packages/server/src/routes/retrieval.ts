import { Hono } from "hono";
import { getDb, getRetrievalStats } from "@exocortex/core";

const retrieval = new Hono();

retrieval.get("/api/retrieval/stats", (c) => {
  const db = getDb();
  return c.json(getRetrievalStats(db));
});

export default retrieval;
