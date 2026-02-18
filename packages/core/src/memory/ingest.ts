import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ContentType, Memory } from "./types.js";
import { MemoryStore } from "./store.js";

export interface IngestOptions {
  tags?: string[];
  importance?: number;
  content_type?: ContentType;
}

export interface IngestFileResult {
  file: string;
  sections: number;
  stored: number;
  skipped: number;
  replaced: number;
  memories: Memory[];
}

export interface IngestResult {
  files: IngestFileResult[];
  totalStored: number;
  totalSkipped: number;
  totalReplaced: number;
}

/** Return the character count of non-header, non-whitespace body text. */
function bodyLength(text: string): number {
  return text
    .split("\n")
    .filter((line) => !/^#+\s/.test(line))
    .join("")
    .replace(/\s/g, "").length;
}

const MIN_BODY_CHARS = 50;

/**
 * Split markdown content into sections by ## headers.
 * Each section includes its header line.
 * No headers → entire content as one section.
 * Short sections (< 50 chars of body text) are merged into neighbors
 * rather than dropped, preserving sub-header structure.
 */
export function splitMarkdownSections(content: string): string[] {
  const lines = content.split("\n");
  const raw: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^##\s/.test(line) && current.length > 0) {
      const text = current.join("\n").trim();
      if (text.length > 0) {
        raw.push(text);
      }
      current = [line];
    } else {
      current.push(line);
    }
  }

  // Flush last section
  if (current.length > 0) {
    const text = current.join("\n").trim();
    if (text.length > 0) {
      raw.push(text);
    }
  }

  // Merge short sections into neighbors instead of dropping them
  const sections: string[] = [];
  for (const section of raw) {
    if (bodyLength(section) >= MIN_BODY_CHARS) {
      sections.push(section);
    } else if (sections.length > 0) {
      // Merge into previous section
      sections[sections.length - 1] += "\n\n" + section;
    } else {
      // No previous section yet — hold as pending to merge forward
      sections.push(section);
    }
  }

  // If the first section ended up short (was held for forward merge), merge into next
  if (sections.length > 1 && bodyLength(sections[0]) < MIN_BODY_CHARS) {
    sections[1] = sections[0] + "\n\n" + sections[1];
    sections.shift();
  }

  // Drop any remaining section that is truly empty (no body at all)
  return sections.filter((s) => bodyLength(s) > 0);
}

/**
 * Ingest a single markdown file into Exocortex as memories.
 * Splits by ## sections, stores each as a separate memory.
 */
export async function ingestMarkdownFile(
  db: DatabaseSync,
  filePath: string,
  options?: IngestOptions
): Promise<IngestFileResult> {
  const absolutePath = path.resolve(filePath);
  const content = fs.readFileSync(absolutePath, "utf-8");
  const sections = splitMarkdownSections(content);

  // Dedup: remove existing memories from the same source file
  const existing = db
    .prepare("SELECT id FROM memories WHERE source_uri = ? AND is_active = 1")
    .all(absolutePath) as Array<{ id: string }>;

  let replaced = 0;
  if (existing.length > 0) {
    const store = new MemoryStore(db);
    for (const row of existing) {
      await store.delete(row.id);
    }
    replaced = existing.length;
  }

  const store = new MemoryStore(db);
  const memories: Memory[] = [];
  let skipped = 0;

  for (const section of sections) {
    if (section.length < 10) {
      skipped++;
      continue;
    }

    const { memory } = await store.create({
      content: section,
      content_type: options?.content_type ?? "note",
      source: "import",
      source_uri: absolutePath,
      importance: options?.importance ?? 0.5,
      tags: options?.tags,
    });
    memories.push(memory);
  }

  return {
    file: absolutePath,
    sections: sections.length,
    stored: memories.length,
    skipped,
    replaced,
    memories,
  };
}

/**
 * Ingest multiple files. Aggregates results.
 */
export async function ingestFiles(
  db: DatabaseSync,
  paths: string[],
  options?: IngestOptions
): Promise<IngestResult> {
  const files: IngestFileResult[] = [];
  let totalStored = 0;
  let totalSkipped = 0;
  let totalReplaced = 0;

  for (const p of paths) {
    const result = await ingestMarkdownFile(db, p, options);
    files.push(result);
    totalStored += result.stored;
    totalSkipped += result.skipped;
    totalReplaced += result.replaced;
  }

  return { files, totalStored, totalSkipped, totalReplaced };
}
