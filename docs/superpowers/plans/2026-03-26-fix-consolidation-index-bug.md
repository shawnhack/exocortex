# Fix Consolidation Index-Shift Bug

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the consolidation dry-run/live index mismatch that has blocked the memory gardening backlog for weeks.

**Architecture:** Two root causes — (1) `applyCommunityAwareFiltering()` writes bridge importance boosts during dry-run, and (2) clusters are targeted by fragile array index instead of stable centroid ID. Fix both: add `dryRun` param to skip writes, replace `consolidate_cluster_index` with `consolidate_cluster_id` (centroid ID).

**Tech Stack:** TypeScript, Vitest, Zod, SQLite (node:sqlite)

---

### Task 1: Guard bridge importance boost behind dryRun flag

**Files:**
- Modify: `packages/core/src/intelligence/consolidation.ts:200-204` (function signature)
- Modify: `packages/core/src/intelligence/consolidation.ts:238-246` (bridge boost)
- Modify: `packages/core/src/intelligence/consolidation.test.ts` (add test)

- [ ] **Step 1: Write a failing test that proves dry-run writes to the DB**

In `packages/core/src/intelligence/consolidation.test.ts`, add a test inside the `applyCommunityAwareFiltering` describe block:

```typescript
it("should NOT boost bridge importance when dryRun is true", () => {
  // Create two communities with a bridge memory
  const e1 = createEntity(db, "e1", "community-one");
  const e2 = createEntity(db, "e2", "community-two");
  const m1 = insertMemoryWithEmbedding(db, { id: "m1", content: "memory one" });
  const m2 = insertMemoryWithEmbedding(db, { id: "m2", content: "memory two" });
  const bridge = insertMemoryWithEmbedding(db, { id: "bridge-dry", content: "bridge memory", importance: 0.5 });

  linkMemoryToEntity(db, m1, e1);
  linkMemoryToEntity(db, m2, e2);
  linkMemoryToEntity(db, bridge, e1);
  linkMemoryToEntity(db, bridge, e2);

  const clusters: ConsolidationCluster[] = [{
    centroidId: m1,
    memberIds: [m1, m2, bridge],
    avgSimilarity: 0.85,
    topic: "dry-run bridge test",
  }];

  applyCommunityAwareFiltering(db, clusters, 2, true); // dryRun = true

  // Bridge importance should remain unchanged at 0.5
  const row = db.prepare("SELECT importance FROM memories WHERE id = ?").get("bridge-dry") as { importance: number };
  expect(row.importance).toBe(0.5);
});

it("should boost bridge importance when dryRun is false", () => {
  const e1 = createEntity(db, "e1b", "community-one-b");
  const e2 = createEntity(db, "e2b", "community-two-b");
  const m1 = insertMemoryWithEmbedding(db, { id: "m1b", content: "memory one b" });
  const m2 = insertMemoryWithEmbedding(db, { id: "m2b", content: "memory two b" });
  const bridge = insertMemoryWithEmbedding(db, { id: "bridge-live", content: "bridge memory b", importance: 0.5 });

  linkMemoryToEntity(db, m1, e1b);
  linkMemoryToEntity(db, m2, e2b);
  linkMemoryToEntity(db, bridge, e1b);
  linkMemoryToEntity(db, bridge, e2b);

  const clusters: ConsolidationCluster[] = [{
    centroidId: m1,
    memberIds: [m1, m2, bridge],
    avgSimilarity: 0.85,
    topic: "live bridge test",
  }];

  applyCommunityAwareFiltering(db, clusters, 2, false); // dryRun = false

  const row = db.prepare("SELECT importance FROM memories WHERE id = ?").get("bridge-live") as { importance: number };
  expect(row.importance).toBe(0.8);
});
```

Note: the `insertMemoryWithEmbedding` helper may need an `importance` field. Check the existing helper — if it doesn't accept `importance`, add it as an optional param that defaults to 0.5.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd D:/Apps/exocortex && pnpm test -- packages/core/src/intelligence/consolidation.test.ts`

Expected: FAIL — `applyCommunityAwareFiltering` doesn't accept a 4th argument yet.

- [ ] **Step 3: Add dryRun parameter to applyCommunityAwareFiltering**

In `packages/core/src/intelligence/consolidation.ts`, change the function signature at line ~200:

```typescript
export function applyCommunityAwareFiltering(
  db: DatabaseSync,
  clusters: ConsolidationCluster[],
  minClusterSize: number = 2,
  dryRun: boolean = false
): CommunityAwareResult {
```

Then guard the bridge boost at lines ~238-246:

```typescript
  // Boost importance of bridge memories to at least 0.8 (skip during dry-run)
  if (bridgeMemoryIds.length > 0 && !dryRun) {
    const boostStmt = db.prepare(
      "UPDATE memories SET importance = MAX(importance, 0.8) WHERE id = ? AND importance < 0.8"
    );
    for (const id of bridgeMemoryIds) {
      boostStmt.run(id);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/Apps/exocortex && pnpm test -- packages/core/src/intelligence/consolidation.test.ts`

Expected: All tests PASS. Existing tests still pass because `dryRun` defaults to `false`.

- [ ] **Step 5: Commit**

```bash
cd D:/Apps/exocortex
git add packages/core/src/intelligence/consolidation.ts packages/core/src/intelligence/consolidation.test.ts
git commit -m "fix: guard bridge importance boost behind dryRun flag in applyCommunityAwareFiltering"
```

---

### Task 2: Replace consolidate_cluster_index with consolidate_cluster_id

**Files:**
- Modify: `packages/mcp/src/tools/memory-maintenance.ts:31` (schema)
- Modify: `packages/mcp/src/tools/memory-maintenance.ts:290-318` (dry-run output + live targeting)

- [ ] **Step 1: Update the Zod schema**

In `packages/mcp/src/tools/memory-maintenance.ts`, replace line 31:

```typescript
// Old:
consolidate_cluster_index: z.number().min(0).optional().describe("Only process this cluster (0-indexed)"),

// New:
consolidate_cluster_id: z.string().optional().describe("Centroid memory ID of the cluster to process (from dry-run output)"),
```

- [ ] **Step 2: Update dry-run output format to show centroid IDs prominently**

In the dry-run branch (~line 300-303), change the output format:

```typescript
const lines = clusters.map((c, i) => {
  return `  ${i + 1}. [${c.centroidId}] "${c.topic}" — ${c.memberIds.length} memories (${c.memberIds.join(", ")}), avg similarity: ${c.avgSimilarity.toFixed(2)}`;
});
parts.push(`\nConsolidate (dry run, ${clusters.length} clusters):\n${lines.join("\n")}${bridgeInfo}\n  To merge: set consolidate_dry_run:false, consolidate_cluster_id:"<centroid_id>", and consolidate_summary:"your synthesis"`);
```

Key change: `[${i}]` becomes `[${c.centroidId}]`, and the instruction line says `consolidate_cluster_id` instead of `consolidate_cluster_index:N`.

- [ ] **Step 3: Update live consolidation to find cluster by centroid ID**

Replace the cluster selection logic (~lines 313-318):

```typescript
// Old:
const toProcess = args.consolidate_cluster_index !== undefined
  ? [clusters[args.consolidate_cluster_index]].filter(Boolean)
  : clusters;

if (toProcess.length === 0) {
  parts.push(`\nConsolidate: invalid cluster_index ${args.consolidate_cluster_index} (${clusters.length} available)`);
}

// New:
const toProcess = args.consolidate_cluster_id
  ? clusters.filter(c => c.centroidId === args.consolidate_cluster_id)
  : clusters;

if (toProcess.length === 0 && args.consolidate_cluster_id) {
  parts.push(`\nConsolidate: no cluster found with centroid ID ${args.consolidate_cluster_id} — re-run dry-run to get current cluster IDs`);
}
```

- [ ] **Step 4: Pass dryRun flag to applyCommunityAwareFiltering**

At line ~284, pass the dry-run flag:

```typescript
// Old:
caResult = applyCommunityAwareFiltering(db, rawClusters, args.consolidate_min_cluster_size ?? 2);

// New:
caResult = applyCommunityAwareFiltering(db, rawClusters, args.consolidate_min_cluster_size ?? 2, args.consolidate_dry_run !== false);
```

- [ ] **Step 5: Run the full test suite**

Run: `cd D:/Apps/exocortex && pnpm test`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/Apps/exocortex
git add packages/mcp/src/tools/memory-maintenance.ts
git commit -m "fix: replace consolidate_cluster_index with ID-based targeting

Clusters are now targeted by centroid memory ID instead of fragile array
index. Fixes the dry-run/live index mismatch that blocked consolidation
for weeks. Also passes dryRun flag to applyCommunityAwareFiltering to
prevent side effects during preview."
```

---

### Task 3: Update sentinel gardening prompt

**Files:**
- Modify: `D:/Apps/substrate/src/scheduler/sentinel.ts:198-208`

- [ ] **Step 1: Update the gardening prompt instructions**

In `sentinel.ts`, replace the consolidation instructions in `buildGardeningPrompt()` (lines ~198-208):

```typescript
2. **Find clusters**: Call \`memory_maintenance\` with \`consolidate: true, consolidate_dry_run: true, consolidate_min_similarity: 0.70, consolidate_min_cluster_size: 2\` to discover similar memory clusters. The response includes centroid IDs and member IDs for each cluster.

3. **Consolidate**: For each cluster found (process one at a time):
   a. Call \`memory_get\` with the member IDs to read their full content
   b. Write a coherent summary following these quality rules:
      - Start with a clear topic sentence (NOT "[Consolidated summary of...]")
      - Write prose paragraphs, not just bullet lists
      - Preserve ALL dates, version numbers, proper nouns, and file paths from the originals
      - Keep under 600 words
      - Self-check: "Does this summary contain the same retrievable keywords as the originals?"
   c. Call \`memory_maintenance\` with \`consolidate: true, consolidate_dry_run: false, consolidate_cluster_id: "<centroid_id>", consolidate_summary: "<your synthesis>"\` — use the centroid ID from the dry-run output, not an array index
```

Key changes:
- Line 198: "cluster indices and member IDs" → "centroid IDs and member IDs"
- Line 208: `consolidate_cluster_index: N` → `consolidate_cluster_id: "<centroid_id>"`
- Added clarification: "use the centroid ID from the dry-run output, not an array index"

- [ ] **Step 2: Run lint to verify no syntax errors**

Run: `cd D:/Apps/substrate && pnpm lint`

Expected: PASS (or only pre-existing warnings).

- [ ] **Step 3: Commit**

```bash
cd D:/Apps/substrate
git add src/scheduler/sentinel.ts
git commit -m "fix: update gardening prompt to use consolidate_cluster_id instead of index"
```

---

### Task 4: Smoke test — manual dry-run + live consolidation

This task validates the fix end-to-end against the live Exocortex database.

- [ ] **Step 1: Rebuild exocortex core and restart the server**

```bash
cd D:/Apps/exocortex && pnpm build
cd D:/Apps/nexus && pm2 restart exocortex
```

Wait a few seconds for the server to come up.

- [ ] **Step 2: Run a dry-run consolidation via MCP**

Use the `memory_maintenance` tool with:
```json
{
  "consolidate": true,
  "consolidate_dry_run": true,
  "consolidate_min_similarity": 0.70,
  "consolidate_min_cluster_size": 2
}
```

Verify:
- Output shows centroid IDs like `[01KM...]` instead of `[0]`, `[1]`, etc.
- Output instruction says `consolidate_cluster_id` not `consolidate_cluster_index`
- No bridge memory importance values changed (check a known bridge memory's importance before and after)

- [ ] **Step 3: Run a live consolidation on one cluster**

Pick a centroid ID from the dry-run output. Call `memory_maintenance` with:
```json
{
  "consolidate": true,
  "consolidate_dry_run": false,
  "consolidate_cluster_id": "<centroid_id_from_step_2>",
  "consolidate_summary": "<write a quality summary of the cluster members>"
}
```

Verify:
- Consolidation succeeds: output says "1 cluster(s) merged"
- Source memories are archived (is_active = 0)
- Summary memory is created

- [ ] **Step 4: Verify re-running dry-run shows updated state**

Run the same dry-run call from Step 2 again. Verify:
- The merged cluster no longer appears
- Remaining cluster centroid IDs are stable (same IDs as before, minus the merged one)

---

## Post-Implementation Notes

- The `findClusters()` function in `consolidation.ts` line 132-136 also calls `applyCommunityAwareFiltering` when `communityAware` option is set. This path is used by `autoConsolidate()` but NOT by the MCP tool's manual consolidation flow (which calls `findClusters` without `communityAware` and then calls `applyCommunityAwareFiltering` separately). No change needed there since `autoConsolidate` always does live writes, but if a `dryRun` path is ever added to `autoConsolidate`, the same guard should apply.
- After deploying, the sentinel's next `memory-gardening` run should successfully merge clusters that have been stuck for weeks. Monitor the next run's output.
