import type { DatabaseSync } from "node:sqlite";

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface StoredFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  memory_id: string;
  confidence: number;
  created_at: string;
}

export interface SearchFactsOptions {
  subject?: string;
  predicate?: string;
  object?: string;
  memory_id?: string;
  limit?: number;
}

// Regex patterns for fact extraction
const PATTERNS: Array<{
  regex: RegExp;
  extract: (m: RegExpExecArray) => ExtractedFact | null;
}> = [
  // "X runs on port N" / "X on port N"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:runs\s+)?on\s+port\s+(\d+)/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "port",
      object: m[2],
      confidence: 0.9,
    }),
  },
  // "port N" (standalone, context-based)
  {
    regex: /\bport\s+(\d+)/gi,
    extract: (m) => ({
      subject: "_context",
      predicate: "port",
      object: m[1],
      confidence: 0.5,
    }),
  },
  // "X uses Y" / "X built with Y"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:uses|built\s+with|powered\s+by)\s+([A-Za-z][\w.-]*(?:\s+[\w.-]+){0,2})/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "uses",
      object: m[2].trim(),
      confidence: 0.8,
    }),
  },
  // "X replaced Y" / "switched from Y to X"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+replaced\s+([A-Za-z][\w.-]*)/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "replaced",
      object: m[2],
      confidence: 0.8,
    }),
  },
  {
    regex: /\bswitched\s+from\s+([A-Za-z][\w.-]*)\s+to\s+([A-Za-z][\w.-]*)/gi,
    extract: (m) => ({
      subject: m[2],
      predicate: "replaced",
      object: m[1],
      confidence: 0.8,
    }),
  },
  // "X at path P" / "data dir: P"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:at\s+path|path[:\s]+|data\s+dir[:\s]+)\s*([A-Za-z]:[/\\][^\s,)]+|\/[^\s,)]+)/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "path",
      object: m[2].replace(/[/\\]+$/, ""),
      confidence: 0.85,
    }),
  },
  // "X defaults to V"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+defaults?\s+to\s+(\S+)/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "default",
      object: m[2],
      confidence: 0.75,
    }),
  },
  // "X version V" / "X vN.N.N"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:version\s+|v)(\d+(?:\.\d+)*(?:-[\w.]+)?)/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "version",
      object: m[2],
      confidence: 0.85,
    }),
  },
  // "X is a/an Y" (short Y, <5 words)
  {
    regex: /\b([A-Z][\w.-]*)\s+is\s+(?:a|an)\s+([a-zA-Z][\w\s-]{2,30}?)(?:\.|,|;|\s*$)/gm,
    extract: (m) => {
      const obj = m[2].trim();
      if (obj.split(/\s+/).length > 5) return null;
      return {
        subject: m[1],
        predicate: "is",
        object: obj,
        confidence: 0.7,
      };
    },
  },
  // "X configured to Y" / "X set to Y"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:configured|set)\s+to\s+(\S+(?:\s+\S+){0,3})/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "config",
      object: m[2].trim().replace(/[.,;]+$/, ""),
      confidence: 0.8,
    }),
  },
  // "X depends on Y" / "X requires Y"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:depends\s+on|requires)\s+([A-Za-z][\w.-]*(?:\s+[\w.-]+){0,2})/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "depends_on",
      object: m[2].trim(),
      confidence: 0.8,
    }),
  },
  // "X located at /path" / "X lives in /dir" / "X located at D:/path"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:located\s+at|lives?\s+in|installed\s+(?:at|in))\s+([A-Za-z]:[/\\][^\s,)]+|\/[^\s,)]+)/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "located_at",
      object: m[2].replace(/[/\\]+$/, ""),
      confidence: 0.85,
    }),
  },
  // "X runs as Y" / "X started with Y"
  {
    regex: /\b([A-Za-z][\w.-]*)\s+(?:runs\s+as|started\s+with|launched\s+(?:as|with))\s+([A-Za-z][\w.-]*(?:\s+[\w.-]+){0,2})/gi,
    extract: (m) => ({
      subject: m[1],
      predicate: "runs_as",
      object: m[2].trim(),
      confidence: 0.8,
    }),
  },
];

/**
 * Extract structured facts (SPO triples) from memory content.
 */
export function extractFacts(content: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const fact = pattern.extract(match);
      if (!fact) continue;

      // Skip standalone port matches if we already have a named port fact
      if (fact.subject === "_context") continue;

      const key = `${fact.subject.toLowerCase()}|${fact.predicate}|${fact.object.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      facts.push(fact);
    }
  }

  return facts;
}

/**
 * Store extracted facts in the database.
 */
export function storeFacts(
  db: DatabaseSync,
  memoryId: string,
  facts: ExtractedFact[]
): void {
  if (facts.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO facts (subject, predicate, object, memory_id, confidence)
     VALUES (?, ?, ?, ?, ?)`
  );

  for (const fact of facts) {
    stmt.run(fact.subject, fact.predicate, fact.object, memoryId, fact.confidence);
  }
}

/**
 * Search facts by subject, predicate, object, or memory_id.
 */
export function searchFacts(
  db: DatabaseSync,
  opts: SearchFactsOptions
): StoredFact[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const limit = opts.limit ?? 20;

  if (opts.subject) {
    conditions.push("subject LIKE ?");
    params.push(`%${opts.subject}%`);
  }
  if (opts.predicate) {
    conditions.push("predicate = ?");
    params.push(opts.predicate);
  }
  if (opts.object) {
    conditions.push("object LIKE ?");
    params.push(`%${opts.object}%`);
  }
  if (opts.memory_id) {
    conditions.push("memory_id = ?");
    params.push(opts.memory_id);
  }

  const where = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return db
    .prepare(
      `SELECT id, subject, predicate, object, memory_id, confidence, created_at
       FROM facts ${where}
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`
    )
    .all(...params, limit) as unknown as StoredFact[];
}
