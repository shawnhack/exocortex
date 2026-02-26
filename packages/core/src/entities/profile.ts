import type { DatabaseSync } from "node:sqlite";
import { EntityStore } from "./store.js";
import { safeJsonParse } from "../db/schema.js";

// Common English stopwords to skip in keyword extraction
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "was", "are",
  "be", "has", "had", "have", "not", "no", "can", "will", "do", "did",
  "should", "would", "could", "may", "might", "shall", "must", "need",
  "we", "you", "he", "she", "they", "its", "our", "my", "your", "his",
  "her", "their", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "than", "too", "very", "just", "about", "above",
  "after", "again", "also", "as", "been", "before", "being", "between",
  "during", "into", "out", "over", "same", "so", "then", "there", "these",
  "those", "through", "under", "up", "when", "where", "which", "while",
  "who", "whom", "why", "how", "what", "new", "use", "used", "using",
  "one", "two", "three", "see", "get", "set", "like", "make", "way",
]);

/**
 * Generate a concise text profile for an entity based on its linked memories
 * and relationships. Returns null if fewer than 3 active memories are linked.
 */
export function generateEntityProfile(
  db: DatabaseSync,
  entityId: string
): { profile: string | null } {
  const entityStore = new EntityStore(db);
  const entity = entityStore.getById(entityId);
  if (!entity) return { profile: null };

  // Count active memories linked to this entity
  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM memory_entities me
    JOIN memories m ON me.memory_id = m.id
    WHERE me.entity_id = ? AND m.is_active = 1
  `).get(entityId) as { cnt: number };

  const activeCount = countRow.cnt;
  if (activeCount < 3) return { profile: null };

  // Fetch top 5 linked active memories by importance
  const topMemories = db.prepare(`
    SELECT m.content, m.importance
    FROM memory_entities me
    JOIN memories m ON me.memory_id = m.id
    WHERE me.entity_id = ? AND m.is_active = 1
    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT 5
  `).all(entityId) as Array<{ content: string; importance: number }>;

  // Fetch top 5 relationships by confidence
  const relationships = db.prepare(`
    SELECT er.relationship, er.confidence,
           CASE WHEN er.source_entity_id = ? THEN e2.name ELSE e1.name END as related_name,
           CASE WHEN er.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
    FROM entity_relationships er
    JOIN entities e1 ON er.source_entity_id = e1.id
    JOIN entities e2 ON er.target_entity_id = e2.id
    WHERE er.source_entity_id = ? OR er.target_entity_id = ?
    ORDER BY er.confidence DESC
    LIMIT 5
  `).all(entityId, entityId, entityId, entityId) as Array<{
    relationship: string;
    confidence: number;
    related_name: string;
    direction: string;
  }>;

  // Extract topic keywords from memory content
  const entityNameLower = entity.name.toLowerCase();
  const entityWords = new Set(entityNameLower.split(/[\s\-_]+/));
  const wordFreq = new Map<string, number>();

  for (const mem of topMemories) {
    // Take first 500 chars of each memory
    const snippet = mem.content.substring(0, 500).toLowerCase();
    const words = snippet.split(/[^a-z0-9]+/).filter(
      (w) => w.length >= 3 && !STOPWORDS.has(w) && !entityWords.has(w)
    );
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  const topKeywords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  // Assemble profile parts
  const typeName = capitalize(entity.type);
  const parts: string[] = [];

  // Relationship summary (deduplicate and group)
  if (relationships.length > 0) {
    const relParts: string[] = [];
    const seen = new Set<string>();
    for (const rel of relationships) {
      const key = `${rel.relationship}-${rel.related_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Format: "Related to X" or "Used by Y"
      const relLabel = formatRelationship(rel.relationship, rel.direction, rel.related_name);
      if (relLabel) relParts.push(relLabel);
    }
    if (relParts.length > 0) {
      parts.push(relParts.join(", "));
    }
  }

  // Topics
  if (topKeywords.length > 0) {
    parts.push(`Topics: ${topKeywords.join(", ")}`);
  }

  const suffix = parts.length > 0 ? `. ${parts.join(". ")}.` : ".";
  const profile = `${typeName} with ${activeCount} memories${suffix}`;

  return { profile };
}

export interface RecomputeProfilesResult {
  computed: number;
  skipped: number;
  errors: number;
}

/**
 * Batch recompute entity profiles for entities with ≥3 active memories
 * that either have no profile or have a stale profile (>7 days old).
 */
export function recomputeEntityProfiles(
  db: DatabaseSync,
  opts?: { force?: boolean }
): RecomputeProfilesResult {
  const force = opts?.force ?? false;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");

  // Find entities with ≥3 active memories
  const candidates = db.prepare(`
    SELECT e.id, e.metadata
    FROM entities e
    JOIN memory_entities me ON e.id = me.entity_id
    JOIN memories m ON me.memory_id = m.id AND m.is_active = 1
    GROUP BY e.id
    HAVING COUNT(*) >= 3
  `).all() as Array<{ id: string; metadata: string }>;

  const entityStore = new EntityStore(db);
  let computed = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      const metadata = safeJsonParse<Record<string, unknown>>(row.metadata, {});

      // Skip if profile is recent (unless force)
      if (!force && metadata.profile && metadata.profile_updated_at) {
        const updatedAt = String(metadata.profile_updated_at);
        if (updatedAt > sevenDaysAgo) {
          skipped++;
          continue;
        }
      }

      const result = generateEntityProfile(db, row.id);
      if (!result.profile) {
        skipped++;
        continue;
      }

      const now = new Date().toISOString().replace("T", " ").replace("Z", "");
      entityStore.update(row.id, {
        metadata: {
          ...metadata,
          profile: result.profile,
          profile_updated_at: now,
        },
      });
      computed++;
    } catch {
      errors++;
    }
  }

  return { computed, skipped, errors };
}

/**
 * Fast lookup of cached profiles for a list of entity IDs.
 * Returns a Map of entityId → profile string.
 */
export function getCachedProfiles(
  db: DatabaseSync,
  entityIds: string[]
): Map<string, string> {
  const profiles = new Map<string, string>();
  if (entityIds.length === 0) return profiles;

  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT id, name, metadata FROM entities WHERE id IN (${placeholders})`
  ).all(...entityIds) as Array<{ id: string; name: string; metadata: string }>;

  for (const row of rows) {
    const metadata = safeJsonParse<Record<string, unknown>>(row.metadata, {});
    if (typeof metadata.profile === "string" && metadata.profile.length > 0) {
      profiles.set(row.id, metadata.profile);
    }
  }

  return profiles;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatRelationship(rel: string, direction: string, name: string): string {
  // Normalize common relationship labels
  const r = rel.toLowerCase();
  if (direction === "outgoing") {
    if (r === "uses" || r === "depends_on") return `Uses ${name}`;
    if (r === "related_to" || r === "co_occurs") return `Related to ${name}`;
    if (r === "part_of" || r === "belongs_to") return `Part of ${name}`;
    if (r === "created_by") return `Created by ${name}`;
    return `${capitalize(rel.replace(/_/g, " "))} ${name}`;
  } else {
    if (r === "uses" || r === "depends_on") return `Used by ${name}`;
    if (r === "related_to" || r === "co_occurs") return `Related to ${name}`;
    if (r === "part_of" || r === "belongs_to") return `Contains ${name}`;
    if (r === "created_by") return `Created ${name}`;
    return `${capitalize(rel.replace(/_/g, " "))} by ${name}`;
  }
}
