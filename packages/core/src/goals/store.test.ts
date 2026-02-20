import { describe, it, expect, beforeEach } from "vitest";
import { getDbForTesting, initializeSchema, MemoryStore, getEmbeddingProvider } from "@exocortex/core";
import type { DatabaseSync } from "@exocortex/core";
import { GoalStore } from "./store.js";

describe("GoalStore", () => {
  let db: DatabaseSync;
  let store: GoalStore;

  beforeEach(() => {
    db = getDbForTesting();
    initializeSchema(db);
    store = new GoalStore(db);
  });

  describe("create", () => {
    it("should create a goal with defaults", () => {
      const goal = store.create({ title: "Ship v1.0" });

      expect(goal.id).toBeTruthy();
      expect(goal.title).toBe("Ship v1.0");
      expect(goal.description).toBeNull();
      expect(goal.status).toBe("active");
      expect(goal.priority).toBe("medium");
      expect(goal.deadline).toBeNull();
      expect(goal.metadata).toEqual({});
      expect(goal.completed_at).toBeNull();
    });

    it("should create a goal with all fields", () => {
      const goal = store.create({
        title: "Launch feature",
        description: "Ship the new dashboard",
        priority: "high",
        deadline: "2026-03-01",
        metadata: { project: "nexus" },
      });

      expect(goal.title).toBe("Launch feature");
      expect(goal.description).toBe("Ship the new dashboard");
      expect(goal.priority).toBe("high");
      expect(goal.deadline).toBe("2026-03-01");
      expect(goal.metadata).toEqual({ project: "nexus" });
    });
  });

  describe("getById", () => {
    it("should return null for non-existent goal", () => {
      expect(store.getById("nonexistent")).toBeNull();
    });

    it("should return created goal", () => {
      const created = store.create({ title: "Test goal" });
      const fetched = store.getById(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe("Test goal");
    });
  });

  describe("list", () => {
    it("should list goals by status", () => {
      store.create({ title: "Active 1" });
      store.create({ title: "Active 2" });
      const g3 = store.create({ title: "Will complete" });
      store.update(g3.id, { status: "completed" });

      const active = store.list("active");
      expect(active).toHaveLength(2);

      const completed = store.list("completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].title).toBe("Will complete");
    });

    it("should list all goals when no status filter", () => {
      store.create({ title: "Goal 1" });
      const g2 = store.create({ title: "Goal 2" });
      store.update(g2.id, { status: "abandoned" });

      const all = store.list();
      expect(all).toHaveLength(2);
    });
  });

  describe("update", () => {
    it("should update goal fields", () => {
      const goal = store.create({ title: "Original" });
      const updated = store.update(goal.id, {
        title: "Updated",
        description: "New description",
        priority: "critical",
      });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("Updated");
      expect(updated!.description).toBe("New description");
      expect(updated!.priority).toBe("critical");
    });

    it("should auto-set completed_at when status changes to completed", () => {
      const goal = store.create({ title: "Goal" });
      expect(goal.completed_at).toBeNull();

      const completed = store.update(goal.id, { status: "completed" });
      expect(completed!.completed_at).not.toBeNull();
      expect(completed!.status).toBe("completed");
    });

    it("should clear completed_at when reopening a completed goal", () => {
      const goal = store.create({ title: "Goal" });
      const completed = store.update(goal.id, { status: "completed" });
      expect(completed!.completed_at).not.toBeNull();

      const reopened = store.update(goal.id, { status: "active" });
      expect(reopened!.status).toBe("active");
      expect(reopened!.completed_at).toBeNull();
    });

    it("should allow clearing nullable fields", () => {
      const goal = store.create({
        title: "Goal",
        description: "temporary",
        deadline: "2026-12-31",
      });

      const updated = store.update(goal.id, {
        description: null,
        deadline: null,
      });

      expect(updated!.description).toBeNull();
      expect(updated!.deadline).toBeNull();
    });

    it("should merge metadata", () => {
      const goal = store.create({
        title: "Goal",
        metadata: { a: 1, b: 2 },
      });

      const updated = store.update(goal.id, {
        metadata: { b: 3, c: 4 },
      });

      expect(updated!.metadata).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("should clear embedding when title changes", async () => {
      const goal = store.create({ title: "Original title" });

      // Manually set an embedding to verify it gets cleared
      db.prepare("UPDATE goals SET embedding = ? WHERE id = ?")
        .run(new Uint8Array(16), goal.id);

      const row1 = db.prepare("SELECT embedding FROM goals WHERE id = ?")
        .get(goal.id) as { embedding: Uint8Array | null };
      expect(row1.embedding).not.toBeNull();

      store.update(goal.id, { title: "New title" });

      const row2 = db.prepare("SELECT embedding FROM goals WHERE id = ?")
        .get(goal.id) as { embedding: Uint8Array | null };
      expect(row2.embedding).toBeNull();
    });

    it("should return null for non-existent goal", () => {
      expect(store.update("nonexistent", { title: "X" })).toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete a goal", () => {
      const goal = store.create({ title: "Delete me" });
      expect(store.delete(goal.id)).toBe(true);
      expect(store.getById(goal.id)).toBeNull();
    });

    it("should return false for non-existent goal", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("logProgress", () => {
    it("should create a memory with goal-progress tag", async () => {
      const goal = store.create({ title: "Track this" });
      const memoryId = await store.logProgress(goal.id, "Made progress on step 1");

      expect(memoryId).toBeTruthy();

      // Verify memory was created with correct tag and metadata
      const row = db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(memoryId) as { content: string; metadata: string } | undefined;

      expect(row).toBeTruthy();
      expect(row!.content).toBe("Made progress on step 1");

      const metadata = JSON.parse(row!.metadata);
      expect(metadata.goal_id).toBe(goal.id);

      const tags = db
        .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
        .all(memoryId) as Array<{ tag: string }>;
      expect(tags.map((t) => t.tag)).toContain("goal-progress");
    });

    it("should throw for non-existent goal", async () => {
      await expect(
        store.logProgress("nonexistent", "Progress")
      ).rejects.toThrow("Goal nonexistent not found");
    });
  });

  describe("getWithProgress", () => {
    it("should return goal with progress entries", async () => {
      const goal = store.create({ title: "With progress" });
      await store.logProgress(goal.id, "Step 1 done");
      await store.logProgress(goal.id, "Step 2 done");

      const result = store.getWithProgress(goal.id);
      expect(result).not.toBeNull();
      expect(result!.title).toBe("With progress");
      expect(result!.progress).toHaveLength(2);
      expect(result!.progress[0].content).toBe("Step 2 done"); // Most recent first
      expect(result!.progress[1].content).toBe("Step 1 done");
    });

    it("should return null for non-existent goal", () => {
      expect(store.getWithProgress("nonexistent")).toBeNull();
    });

    it("should respect progress limit", async () => {
      const goal = store.create({ title: "Many steps" });
      await store.logProgress(goal.id, "Step 1");
      await store.logProgress(goal.id, "Step 2");
      await store.logProgress(goal.id, "Step 3");

      const result = store.getWithProgress(goal.id, 2);
      expect(result!.progress).toHaveLength(2);
    });
  });

  describe("detectRelevantGoals", () => {
    it("should find goals via keyword fallback (no embedding)", async () => {
      store.create({ title: "Ship OAuth2 authentication" });
      store.create({ title: "Redesign dashboard layout" });

      // No embedding passed — uses keyword fallback
      const matches = await store.detectRelevantGoals(
        "Finished implementing the OAuth2 token refresh flow for authentication"
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].title).toBe("Ship OAuth2 authentication");
    });

    it("should return empty for unrelated content", async () => {
      store.create({ title: "Ship OAuth2 authentication" });

      const matches = await store.detectRelevantGoals(
        "Updated the README with new installation instructions"
      );

      expect(matches).toHaveLength(0);
    });

    it("should ignore completed goals", async () => {
      const goal = store.create({ title: "Ship OAuth2 authentication" });
      store.update(goal.id, { status: "completed" });

      const matches = await store.detectRelevantGoals(
        "More OAuth2 authentication work done"
      );

      expect(matches).toHaveLength(0);
    });

    it("should match semantically when embedding is provided", async () => {
      // Goal uses specific terms
      store.create({
        title: "Ship v1.0 release",
        description: "Deploy the first version of the platform to production",
      });

      // Content uses different words but same meaning
      const content = "Deployed the first version of the product to the production server";

      // Generate embedding for the content
      const provider = await getEmbeddingProvider();
      const embedding = await provider.embed(content);

      const matches = await store.detectRelevantGoals(content, embedding);

      // Semantic matching should catch this even though keywords barely overlap
      expect(matches).toHaveLength(1);
      expect(matches[0].title).toBe("Ship v1.0 release");
    });

    it("should sort by match strength", async () => {
      store.create({ title: "Build API endpoints" });
      store.create({ title: "Build API authentication middleware" });

      const matches = await store.detectRelevantGoals(
        "Added authentication middleware to the API gateway"
      );

      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].title).toBe("Build API authentication middleware");
    });
  });

  describe("autoLinkProgress", () => {
    it("should tag and link memory to matching goal", async () => {
      const goal = store.create({ title: "Implement goal tracking" });

      // Insert a bare memory to simulate what memory_store creates
      const memoryId = "test-memory-" + Math.random().toString(36).slice(2);
      db.prepare(
        `INSERT INTO memories (id, content, content_type, source, created_at, updated_at)
         VALUES (?, ?, 'text', 'mcp', datetime('now'), datetime('now'))`
      ).run(memoryId, "Added goal tracking feature with progress detection");

      const linked = await store.autoLinkProgress(
        memoryId,
        "Added goal tracking feature with progress detection"
      );

      expect(linked).toEqual([goal.id]);

      // Verify tags were added
      const tags = db
        .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?")
        .all(memoryId) as Array<{ tag: string }>;
      const tagNames = tags.map((t) => t.tag);
      expect(tagNames).toContain("goal-progress");
      expect(tagNames).toContain("goal-progress-implicit");

      // Verify metadata was set
      const row = db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(memoryId) as { metadata: string };
      const metadata = JSON.parse(row.metadata);
      expect(metadata.goal_id).toBe(goal.id);
    });

    it("should return empty when no goals match", async () => {
      store.create({ title: "Unrelated goal" });

      const memoryId = "test-memory-" + Math.random().toString(36).slice(2);
      db.prepare(
        `INSERT INTO memories (id, content, content_type, source, created_at, updated_at)
         VALUES (?, ?, 'text', 'mcp', datetime('now'), datetime('now'))`
      ).run(memoryId, "Something completely different about cooking");

      const linked = await store.autoLinkProgress(memoryId, "Something completely different about cooking");
      expect(linked).toHaveLength(0);
    });

    it("should make auto-linked memories visible in getWithProgress", async () => {
      const goal = store.create({ title: "Implement goal tracking" });

      const memoryId = "test-memory-" + Math.random().toString(36).slice(2);
      db.prepare(
        `INSERT INTO memories (id, content, content_type, source, is_active, created_at, updated_at)
         VALUES (?, ?, 'text', 'mcp', 1, datetime('now'), datetime('now'))`
      ).run(memoryId, "Made progress on goal tracking implementation");

      await store.autoLinkProgress(memoryId, "Made progress on goal tracking implementation");

      const result = store.getWithProgress(goal.id);
      expect(result).not.toBeNull();
      expect(result!.progress).toHaveLength(1);
      expect(result!.progress[0].id).toBe(memoryId);
    });

    it("should cache goal embeddings after first call", async () => {
      store.create({
        title: "Build deployment pipeline",
        description: "Set up CI/CD for automated deployments",
      });

      const content = "Configured the CI/CD pipeline with GitHub Actions for automated deployments";
      const provider = await getEmbeddingProvider();
      const embedding = await provider.embed(content);

      const memoryId1 = "test-mem-" + Math.random().toString(36).slice(2);
      db.prepare(
        `INSERT INTO memories (id, content, content_type, source, is_active, created_at, updated_at)
         VALUES (?, ?, 'text', 'mcp', 1, datetime('now'), datetime('now'))`
      ).run(memoryId1, content);

      await store.autoLinkProgress(memoryId1, content, embedding);

      // Check that goal now has an embedding cached in the DB
      const row = db.prepare("SELECT embedding FROM goals WHERE embedding IS NOT NULL")
        .get() as { embedding: Uint8Array } | undefined;
      expect(row).toBeTruthy();
      expect(row!.embedding.byteLength).toBeGreaterThan(0);
    });
  });

  describe("milestones", () => {
    it("should add a milestone to a goal", () => {
      const goal = store.create({ title: "Multi-step goal" });
      const milestone = store.addMilestone(goal.id, { title: "Step 1" });

      expect(milestone.id).toBeTruthy();
      expect(milestone.title).toBe("Step 1");
      expect(milestone.status).toBe("pending");
      expect(milestone.order).toBe(1);
      expect(milestone.deadline).toBeNull();
      expect(milestone.completed_at).toBeNull();
    });

    it("should auto-increment order", () => {
      const goal = store.create({ title: "Ordered goal" });
      const m1 = store.addMilestone(goal.id, { title: "First" });
      const m2 = store.addMilestone(goal.id, { title: "Second" });

      expect(m1.order).toBe(1);
      expect(m2.order).toBe(2);
    });

    it("should respect explicit order", () => {
      const goal = store.create({ title: "Custom order" });
      const m1 = store.addMilestone(goal.id, { title: "Third", order: 3 });

      expect(m1.order).toBe(3);
    });

    it("should update a milestone", () => {
      const goal = store.create({ title: "Update test" });
      const milestone = store.addMilestone(goal.id, { title: "Original" });

      const updated = store.updateMilestone(goal.id, milestone.id, {
        title: "Updated",
        status: "in_progress",
        deadline: "2026-06-01",
      });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("Updated");
      expect(updated!.status).toBe("in_progress");
      expect(updated!.deadline).toBe("2026-06-01");
    });

    it("should set completed_at when status changes to completed", () => {
      const goal = store.create({ title: "Complete test" });
      const milestone = store.addMilestone(goal.id, { title: "Will complete" });

      const updated = store.updateMilestone(goal.id, milestone.id, {
        status: "completed",
      });

      expect(updated!.status).toBe("completed");
      expect(updated!.completed_at).not.toBeNull();
    });

    it("should remove a milestone", () => {
      const goal = store.create({ title: "Remove test" });
      const milestone = store.addMilestone(goal.id, { title: "To remove" });

      expect(store.removeMilestone(goal.id, milestone.id)).toBe(true);
      expect(store.getMilestones(goal.id)).toHaveLength(0);
    });

    it("should return false removing non-existent milestone", () => {
      const goal = store.create({ title: "No milestone" });
      expect(store.removeMilestone(goal.id, "nonexistent")).toBe(false);
    });

    it("should get milestones sorted by order", () => {
      const goal = store.create({ title: "Sorted milestones" });
      store.addMilestone(goal.id, { title: "Third", order: 3 });
      store.addMilestone(goal.id, { title: "First", order: 1 });
      store.addMilestone(goal.id, { title: "Second", order: 2 });

      const milestones = store.getMilestones(goal.id);
      expect(milestones).toHaveLength(3);
      expect(milestones[0].title).toBe("First");
      expect(milestones[1].title).toBe("Second");
      expect(milestones[2].title).toBe("Third");
    });

    it("should include milestones in getWithProgress", () => {
      const goal = store.create({ title: "Full goal" });
      store.addMilestone(goal.id, { title: "Milestone A" });
      store.addMilestone(goal.id, { title: "Milestone B" });

      const result = store.getWithProgress(goal.id);
      expect(result).not.toBeNull();
      expect(result!.milestones).toHaveLength(2);
      expect(result!.milestones[0].title).toBe("Milestone A");
    });

    it("should throw when adding milestone to non-existent goal", () => {
      expect(() => store.addMilestone("nonexistent", { title: "X" })).toThrow(
        "Goal nonexistent not found"
      );
    });

    it("should return null updating milestone on non-existent goal", () => {
      expect(store.updateMilestone("nonexistent", "x", { title: "Y" })).toBeNull();
    });

    it("should store milestones with deadline", () => {
      const goal = store.create({ title: "Deadline test" });
      const m = store.addMilestone(goal.id, {
        title: "Has deadline",
        deadline: "2026-12-31",
      });

      expect(m.deadline).toBe("2026-12-31");

      const fetched = store.getMilestones(goal.id);
      expect(fetched[0].deadline).toBe("2026-12-31");
    });
  });

  describe("findStalled", () => {
    it("should find active goals with no recent progress", () => {
      store.create({ title: "Stalled goal" });

      // With stallDays=0, any goal without progress is stalled
      const stalled = store.findStalled(0);
      expect(stalled).toHaveLength(1);
      expect(stalled[0].title).toBe("Stalled goal");
    });

    it("should not include goals with recent progress", async () => {
      const goal = store.create({ title: "Active goal" });
      await store.logProgress(goal.id, "Just did something");

      const stalled = store.findStalled(7);
      expect(stalled).toHaveLength(0);
    });

    it("should not include completed goals", () => {
      const goal = store.create({ title: "Done goal" });
      store.update(goal.id, { status: "completed" });

      const stalled = store.findStalled(0);
      expect(stalled).toHaveLength(0);
    });
  });
});
