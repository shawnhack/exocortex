import type { DatabaseSync } from "node:sqlite";

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  components: number;
  avgDegree: number;
}

export interface EntityCentrality {
  entityId: string;
  entityName: string;
  degree: number;
  betweenness: number;
  memoryCount: number;
}

interface AdjacencyList {
  nodes: Map<string, string>; // id → name
  edges: Map<string, Set<string>>; // id → set of neighbor ids
  edgeCount: number;
}

function buildAdjacencyList(db: DatabaseSync): AdjacencyList {
  const entities = db
    .prepare("SELECT id, name FROM entities")
    .all() as Array<{ id: string; name: string }>;

  const relationships = db
    .prepare("SELECT source_entity_id, target_entity_id FROM entity_relationships")
    .all() as Array<{ source_entity_id: string; target_entity_id: string }>;

  const nodes = new Map<string, string>();
  const edges = new Map<string, Set<string>>();

  for (const e of entities) {
    nodes.set(e.id, e.name);
    edges.set(e.id, new Set());
  }

  let edgeCount = 0;
  for (const r of relationships) {
    if (!nodes.has(r.source_entity_id) || !nodes.has(r.target_entity_id)) continue;
    if (r.source_entity_id === r.target_entity_id) continue;

    const srcNeighbors = edges.get(r.source_entity_id)!;
    const tgtNeighbors = edges.get(r.target_entity_id)!;

    // Count unique edges only
    if (!srcNeighbors.has(r.target_entity_id)) {
      edgeCount++;
    }

    srcNeighbors.add(r.target_entity_id);
    tgtNeighbors.add(r.source_entity_id);
  }

  return { nodes, edges, edgeCount };
}

function countComponents(adj: AdjacencyList): number {
  const visited = new Set<string>();
  let components = 0;

  for (const nodeId of adj.nodes.keys()) {
    if (visited.has(nodeId)) continue;
    components++;

    // BFS
    const queue = [nodeId];
    visited.add(nodeId);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adj.edges.get(current);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
  }

  return components;
}

/**
 * Compute betweenness centrality via BFS from each node.
 * Brandes' algorithm: O(V*E)
 */
function computeBetweenness(adj: AdjacencyList): Map<string, number> {
  const betweenness = new Map<string, number>();
  for (const nodeId of adj.nodes.keys()) {
    betweenness.set(nodeId, 0);
  }

  const nodeIds = Array.from(adj.nodes.keys());

  for (const source of nodeIds) {
    // BFS from source (Brandes)
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>();
    const sigma = new Map<string, number>(); // number of shortest paths
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const v of nodeIds) {
      predecessors.set(v, []);
      sigma.set(v, 0);
      dist.set(v, -1);
      delta.set(v, 0);
    }

    sigma.set(source, 1);
    dist.set(source, 0);
    const queue: string[] = [source];

    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);

      const neighbors = adj.edges.get(v);
      if (!neighbors) continue;

      for (const w of neighbors) {
        // w found for the first time?
        if (dist.get(w)! === -1) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        // Shortest path to w via v?
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          predecessors.get(w)!.push(v);
        }
      }
    }

    // Accumulate
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of predecessors.get(w)!) {
        const contribution = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contribution);
      }
      if (w !== source) {
        betweenness.set(w, betweenness.get(w)! + delta.get(w)!);
      }
    }
  }

  // Normalize: divide by (n-1)(n-2) for undirected graph
  const n = nodeIds.length;
  const normFactor = n > 2 ? (n - 1) * (n - 2) : 1;
  for (const [id, val] of betweenness) {
    // Undirected: each pair counted twice in Brandes, divide by 2
    betweenness.set(id, val / (2 * normFactor));
  }

  return betweenness;
}

function getMemoryCounts(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare("SELECT entity_id, COUNT(*) as cnt FROM memory_entities GROUP BY entity_id")
    .all() as Array<{ entity_id: string; cnt: number }>;

  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.entity_id, r.cnt);
  }
  return counts;
}

export function computeGraphStats(db: DatabaseSync): GraphStats {
  const adj = buildAdjacencyList(db);
  const components = adj.nodes.size > 0 ? countComponents(adj) : 0;
  const avgDegree =
    adj.nodes.size > 0
      ? Math.round(((2 * adj.edgeCount) / adj.nodes.size) * 100) / 100
      : 0;

  return {
    nodeCount: adj.nodes.size,
    edgeCount: adj.edgeCount,
    components,
    avgDegree,
  };
}

export function computeCentrality(db: DatabaseSync): EntityCentrality[] {
  const adj = buildAdjacencyList(db);
  if (adj.nodes.size === 0) return [];

  const memoryCounts = getMemoryCounts(db);

  // Skip betweenness for large graphs — degree only
  const skipBetweenness = adj.nodes.size > 1000;
  const betweenness = skipBetweenness
    ? new Map<string, number>()
    : computeBetweenness(adj);

  const results: EntityCentrality[] = [];

  for (const [id, name] of adj.nodes) {
    const degree = adj.edges.get(id)?.size ?? 0;
    results.push({
      entityId: id,
      entityName: name,
      degree,
      betweenness: betweenness.get(id) ?? 0,
      memoryCount: memoryCounts.get(id) ?? 0,
    });
  }

  // Sort by betweenness descending, then degree descending
  results.sort((a, b) => b.betweenness - a.betweenness || b.degree - a.degree);

  return results;
}

export interface Community {
  id: number;
  members: Array<{ entityId: string; entityName: string }>;
  size: number;
  internalEdges: number;
}

/**
 * Detect communities using label propagation.
 * O(V+E) per iteration, typically converges in ~10 iterations.
 * Skips singletons. Returns communities sorted by size descending.
 */
export function detectCommunities(
  db: DatabaseSync,
  maxIterations = 10
): Community[] {
  const adj = buildAdjacencyList(db);
  if (adj.nodes.size === 0) return [];

  // Initialize: each node is its own label
  const labels = new Map<string, number>();
  let labelId = 0;
  for (const nodeId of adj.nodes.keys()) {
    labels.set(nodeId, labelId++);
  }

  const nodeIds = Array.from(adj.nodes.keys());

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Shuffle node order for each iteration
    for (let i = nodeIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nodeIds[i], nodeIds[j]] = [nodeIds[j], nodeIds[i]];
    }

    for (const nodeId of nodeIds) {
      const neighbors = adj.edges.get(nodeId);
      if (!neighbors || neighbors.size === 0) continue;

      // Count neighbor label frequencies
      const freq = new Map<number, number>();
      for (const n of neighbors) {
        const nLabel = labels.get(n)!;
        freq.set(nLabel, (freq.get(nLabel) ?? 0) + 1);
      }

      // Adopt most frequent neighbor label
      let bestLabel = labels.get(nodeId)!;
      let bestCount = 0;
      for (const [label, count] of freq) {
        if (count > bestCount) {
          bestCount = count;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(nodeId)) {
        labels.set(nodeId, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Group by label
  const groups = new Map<number, string[]>();
  for (const [nodeId, label] of labels) {
    const arr = groups.get(label);
    if (arr) arr.push(nodeId);
    else groups.set(label, [nodeId]);
  }

  // Build communities, skip singletons
  const communities: Community[] = [];
  let communityId = 0;

  for (const memberIds of groups.values()) {
    if (memberIds.length < 2) continue;

    // Count internal edges
    let internalEdges = 0;
    const memberSet = new Set(memberIds);
    for (const nodeId of memberIds) {
      const neighbors = adj.edges.get(nodeId);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (memberSet.has(n)) internalEdges++;
      }
    }
    // Each undirected edge counted twice
    internalEdges = Math.floor(internalEdges / 2);

    communities.push({
      id: communityId++,
      members: memberIds.map((id) => ({
        entityId: id,
        entityName: adj.nodes.get(id) ?? id,
      })),
      size: memberIds.length,
      internalEdges,
    });
  }

  communities.sort((a, b) => b.size - a.size);
  return communities;
}

export function getTopBridgeEntities(
  db: DatabaseSync,
  limit = 10
): EntityCentrality[] {
  return computeCentrality(db).slice(0, limit);
}
