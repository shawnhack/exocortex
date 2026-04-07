/**
 * Memory Provenance Chains — track the full derivation history of memories.
 *
 * When an agent reads memories and produces a new one, this module records
 * which source memories contributed, enabling forensic tracing back to the
 * original external URL or input that seeded the knowledge.
 */

export interface ProvenanceRecord {
  /** Memory IDs that were read/consulted when creating this memory */
  derived_from?: string[];
  /** Original external URL this knowledge ultimately traces back to */
  original_source_url?: string;
  /** Chain depth — how many derivation steps from the original source */
  derivation_depth: number;
  /** Trust level of the original source */
  source_trust: "internal" | "verified" | "external" | "untrusted";
  /** Timestamp of original ingestion */
  first_ingested?: string;
  /** Agent that created this memory */
  creating_agent?: string;
  /** Session in which this memory was created */
  creating_session?: string;
}

/**
 * Build a provenance record for a new memory.
 */
export function buildProvenance(opts: {
  derivedFrom?: string[];
  sourceUrl?: string;
  trust?: "internal" | "verified" | "external" | "untrusted";
  agent?: string;
  sessionId?: string;
  parentProvenance?: ProvenanceRecord;
}): ProvenanceRecord {
  const depth = opts.parentProvenance
    ? opts.parentProvenance.derivation_depth + 1
    : opts.sourceUrl ? 0 : 0;

  return {
    derived_from: opts.derivedFrom,
    original_source_url: opts.sourceUrl ?? opts.parentProvenance?.original_source_url,
    derivation_depth: depth,
    source_trust: opts.trust ?? opts.parentProvenance?.source_trust ?? "internal",
    first_ingested: opts.parentProvenance?.first_ingested ?? new Date().toISOString(),
    creating_agent: opts.agent,
    creating_session: opts.sessionId,
  };
}

/**
 * Extract provenance from memory metadata.
 */
export function extractProvenance(metadata: Record<string, unknown> | undefined): ProvenanceRecord | null {
  if (!metadata?.provenance) return null;
  return metadata.provenance as ProvenanceRecord;
}

/**
 * Merge provenance into existing metadata.
 */
export function mergeProvenance(
  metadata: Record<string, unknown> | undefined,
  provenance: ProvenanceRecord,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    provenance,
  };
}

/**
 * Calculate aggregate trust for content derived from multiple sources.
 * The weakest link determines the trust level.
 */
export function aggregateTrust(
  trustLevels: Array<"internal" | "verified" | "external" | "untrusted">,
): "internal" | "verified" | "external" | "untrusted" {
  const TRUST_ORDER = ["untrusted", "external", "verified", "internal"] as const;

  let lowestIdx = TRUST_ORDER.length - 1;
  for (const trust of trustLevels) {
    const idx = TRUST_ORDER.indexOf(trust);
    if (idx < lowestIdx) lowestIdx = idx;
  }

  return TRUST_ORDER[lowestIdx];
}
