import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting } from "../db/connection.js";
import { AgentTaskStore } from "./store.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * Focused on claim() semantics.
 *
 * claim() is the only path by which a scheduled agent picks up delegated work,
 * and its status matching is load-bearing: for months a routing defect left
 * tasks assigned to agents that never called it, and on 2026-08-01 an agent
 * claimed a task and abandoned it without completing or failing, stranding it
 * in `in_progress` where nothing could ever pick it up again. Both failure
 * modes were silent. These tests pin the behaviour that makes them loud.
 */

let db: DatabaseSync;
let store: AgentTaskStore;

const AGENT = "sentinel:test-agent";

beforeEach(() => {
  db = getDbForTesting();
  store = new AgentTaskStore(db);
  db.exec("DELETE FROM agent_tasks");
});

/** Force a task's started_at into the past to simulate an abandoned claim. */
function ageClaim(id: string, hours: number): void {
  db.prepare(
    `UPDATE agent_tasks SET started_at = datetime('now', ?) WHERE id = ?`,
  ).run(`-${hours} hours`, id);
}

describe("AgentTaskStore.claim", () => {
  it("claims an assigned task and marks it in_progress", () => {
    const created = store.create({
      title: "assigned work",
      created_by: "dispatcher",
      assignee: AGENT,
    });
    expect(created.status).toBe("assigned");

    const claimed = store.claim(AGENT);
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.started_at).toBeTruthy();
  });

  it("returns null when the agent has no work", () => {
    store.create({ title: "someone else's", created_by: "dispatcher", assignee: "other:agent" });
    expect(store.claim(AGENT)).toBeNull();
  });

  it("does not hand the same task to a second caller", () => {
    store.create({ title: "only one", created_by: "dispatcher", assignee: AGENT });
    expect(store.claim(AGENT)).not.toBeNull();
    expect(store.claim(AGENT)).toBeNull();
  });

  it("orders by priority before age", () => {
    store.create({ title: "old low", created_by: "d", assignee: AGENT, priority: "low" });
    store.create({ title: "new critical", created_by: "d", assignee: AGENT, priority: "critical" });
    expect(store.claim(AGENT)?.title).toBe("new critical");
  });

  it("leaves a freshly claimed task alone", () => {
    // Regression guard: the stale-reclaim window must never be short enough to
    // steal work from a job that is still running. The longest scheduled job
    // timeout is 15 minutes, so anything inside that must stay locked.
    store.create({ title: "in flight", created_by: "d", assignee: AGENT });
    store.claim(AGENT);
    expect(store.claim(AGENT)).toBeNull();

    const t = store.list({ assignee: AGENT })[0];
    ageClaim(t.id, 1);
    expect(store.claim(AGENT)).toBeNull();
  });

  it("reclaims a task abandoned in in_progress past the stale window", () => {
    // The 2026-08-01 failure: claimed, never completed or failed, invisible
    // to every later run because claim() only matched pending/assigned.
    const created = store.create({ title: "abandoned", created_by: "d", assignee: AGENT });
    store.claim(AGENT);
    expect(store.claim(AGENT)).toBeNull();

    ageClaim(created.id, 7);

    const reclaimed = store.claim(AGENT);
    expect(reclaimed?.id).toBe(created.id);
    expect(reclaimed?.status).toBe("in_progress");
  });

  it("never reclaims completed or failed tasks", () => {
    const done = store.create({ title: "done", created_by: "d", assignee: AGENT });
    store.claim(AGENT);
    store.update(done.id, { status: "completed", result: "ok" });
    ageClaim(done.id, 99);

    const bad = store.create({ title: "bad", created_by: "d", assignee: AGENT });
    store.claim(AGENT);
    store.update(bad.id, { status: "failed", result: "nope" });
    ageClaim(bad.id, 99);

    expect(store.claim(AGENT)).toBeNull();
  });
});
