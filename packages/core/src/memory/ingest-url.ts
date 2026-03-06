import type { DatabaseSync } from "node:sqlite";
import type { Memory, MemoryTier } from "./types.js";
import { MemoryStore } from "./store.js";
import { splitIntoChunks } from "./chunking.js";
import { getTagAliasMap, normalizeTags } from "./tag-normalization.js";
import { getSetting } from "../db/schema.js";

// --- HTML → Text Extraction ---

/** Remove HTML tags and their content for non-content elements */
function stripNonContentTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Extract page title from HTML */
function extractTitle(html: string): string | null {
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1].trim();

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) return titleTag[1].trim();

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, "").trim();

  return null;
}

/** Extract meta description */
function extractDescription(html: string): string | null {
  const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  if (ogDesc) return ogDesc[1].trim();

  const metaDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  if (metaDesc) return metaDesc[1].trim();

  return null;
}

/** Convert HTML to clean text */
export function htmlToText(html: string): string {
  let text = stripNonContentTags(html);

  // Convert headings to markdown-style
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, content) => {
    const hashes = "#".repeat(parseInt(level));
    return `\n\n${hashes} ${content.replace(/<[^>]+>/g, "").trim()}\n`;
  });

  // Block elements → newlines
  text = text.replace(/<\/?(p|div|br|li|tr|blockquote|pre|article|section)[^>]*>/gi, "\n");
  text = text.replace(/<hr[^>]*>/gi, "\n---\n");

  // Inline formatting
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Links — keep text and URL
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code)));

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

// --- URL Ingestion ---

export interface IngestUrlOptions {
  url: string;
  /** Pre-fetched content (markdown/text). If provided, skips HTTP fetch. */
  content?: string;
  /** Document title. Auto-extracted from HTML if not provided. */
  title?: string;
  tags?: string[];
  importance?: number;
  tier?: MemoryTier;
  namespace?: string;
  /** Chunk target size in characters (default from settings, fallback 500) */
  chunk_size?: number;
  /** Chunk overlap in characters (default 50) */
  chunk_overlap?: number;
  /** Attribution */
  provider?: string;
  model_id?: string;
  model_name?: string;
  agent?: string;
}

export interface IngestUrlResult {
  url: string;
  title: string;
  description: string | null;
  parent_id: string;
  chunks_stored: number;
  total_chars: number;
  replaced: number;
  tier: string;
}

/**
 * Ingest a URL or pre-fetched content into Exocortex as chunked reference knowledge.
 *
 * Flow:
 * 1. Fetch URL (or use provided content)
 * 2. Extract text from HTML (or use markdown directly)
 * 3. Create parent document memory with title + metadata
 * 4. Chunk content with overlap
 * 5. Store each chunk as child memory with tier=reference
 */
export async function ingestUrl(
  db: DatabaseSync,
  options: IngestUrlOptions
): Promise<IngestUrlResult> {
  const { url } = options;
  let content = options.content ?? null;
  let title = options.title ?? null;
  let description: string | null = null;
  let isHtml = false;

  // 1. Fetch if no content provided
  if (!content) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Exocortex/1.0 (Knowledge Ingestion)",
        "Accept": "text/html,text/plain,application/json,*/*",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    content = await response.text();
    isHtml = contentType.includes("html");
  } else {
    // Check if provided content looks like HTML
    isHtml = content.trimStart().startsWith("<") && /<html|<head|<body|<!doctype/i.test(content.slice(0, 200));
  }

  // 2. Extract text from HTML
  if (isHtml) {
    if (!title) title = extractTitle(content);
    description = extractDescription(content);
    content = htmlToText(content);
  }

  if (!content || content.length < 50) {
    throw new Error(`Extracted content too short (${content?.length ?? 0} chars). Page may require JavaScript rendering — try browser_scrape first and pass the content.`);
  }

  if (!title) {
    // Derive title from first line or URL
    const firstLine = content.split("\n").find(l => l.trim().length > 0);
    title = firstLine && firstLine.length < 200
      ? firstLine.replace(/^#+\s*/, "").trim()
      : new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
  }

  const aliasMap = getTagAliasMap(db);
  const normalizedTags = normalizeTags(options.tags, aliasMap);
  const tier = options.tier ?? "reference";
  const importance = options.importance ?? 0.6;
  const chunkSize = options.chunk_size ?? parseInt(getSetting(db, "chunking.target_size") ?? "500", 10);
  const chunkOverlap = options.chunk_overlap ?? 50;

  // 3. Remove existing memories from same URL
  const existing = db
    .prepare("SELECT id FROM memories WHERE source_uri = ? AND is_active = 1")
    .all(url) as Array<{ id: string }>;

  const store = new MemoryStore(db);
  let replaced = 0;
  if (existing.length > 0) {
    for (const row of existing) {
      await store.delete(row.id);
    }
    replaced = existing.length;
  }

  // 4. Create parent document memory
  const parentContent = `# ${title}\n\nSource: ${url}\n${description ? `\n${description}\n` : ""}\n---\n\n${content.slice(0, 500)}${content.length > 500 ? "..." : ""}`;

  const { memory: parent } = await store.create({
    content: parentContent,
    content_type: "text",
    source: "import",
    source_uri: url,
    importance,
    tags: [...normalizedTags, "document"],
    tier,
    namespace: options.namespace,
    provider: options.provider,
    model_id: options.model_id,
    model_name: options.model_name,
    agent: options.agent,
    metadata: {
      document_title: title,
      document_url: url,
      document_description: description,
      total_chars: content.length,
      ingested_at: new Date().toISOString(),
    },
  });

  // 5. Chunk and store children
  const chunks = splitIntoChunks(content, {
    targetSize: chunkSize,
    overlap: chunkOverlap,
  });

  let chunksStored = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].trim().length < 20) continue;

    await store.create({
      content: chunks[i],
      content_type: "text",
      source: "import",
      source_uri: url,
      importance,
      tags: normalizedTags,
      tier,
      parent_id: parent.id,
      namespace: options.namespace,
      provider: options.provider,
      model_id: options.model_id,
      model_name: options.model_name,
      agent: options.agent,
    });
    chunksStored++;
  }

  return {
    url,
    title,
    description,
    parent_id: parent.id,
    chunks_stored: chunksStored,
    total_chars: content.length,
    replaced,
    tier,
  };
}

/**
 * Ingest multiple URLs. Returns results for each.
 */
export async function ingestUrls(
  db: DatabaseSync,
  urls: string[],
  options?: Omit<IngestUrlOptions, "url" | "content" | "title">
): Promise<IngestUrlResult[]> {
  const results: IngestUrlResult[] = [];
  for (const url of urls) {
    const result = await ingestUrl(db, { ...options, url });
    results.push(result);
  }
  return results;
}
