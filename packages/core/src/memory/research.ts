import type { DatabaseSync } from "node:sqlite";
import type { MemoryTier } from "./types.js";
import { ingestUrl, type IngestUrlResult } from "./ingest-url.js";
import { htmlToText } from "./ingest-url.js";

// --- Web Search ---

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

/** Domains to skip — low-value for knowledge ingestion */
const BLOCKED_DOMAINS = new Set([
  "youtube.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "pinterest.com",
  "linkedin.com",
  "amazon.com",
  "ebay.com",
]);

function isDomainBlocked(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return BLOCKED_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Search DuckDuckGo HTML and extract result URLs + titles + snippets.
 * No API key required.
 */
export async function searchWeb(
  query: string,
  maxResults: number = 10
): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `Search failed: ${response.status} ${response.statusText}`
    );
  }

  const html = await response.text();
  const hits: SearchHit[] = [];

  // DuckDuckGo HTML results are in <a class="result__a" href="...">title</a>
  // with snippets in <a class="result__snippet" ...>text</a>
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && hits.length < maxResults; i++) {
    const block = resultBlocks[i];

    // Extract URL from result__a href
    const linkMatch = block.match(
      /class="result__a"[^>]*href="([^"]+)"/
    );
    if (!linkMatch) continue;

    let resultUrl = linkMatch[1];
    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    const uddgMatch = resultUrl.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      resultUrl = decodeURIComponent(uddgMatch[1]);
    }

    if (isDomainBlocked(resultUrl)) continue;

    // Extract title
    const titleMatch = block.match(
      /class="result__a"[^>]*>([\s\S]*?)<\/a>/
    );
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
      : resultUrl;

    // Extract snippet
    const snippetMatch = block.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
    );
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    hits.push({ url: resultUrl, title, snippet });
  }

  return hits;
}

// --- Research Orchestration ---

export interface ResearchOptions {
  topic: string;
  /** Additional search queries to run (beyond the topic itself) */
  queries?: string[];
  /** Max sources to ingest (default 5) */
  max_sources?: number;
  /** Max search results to consider per query (default 10) */
  max_results_per_query?: number;
  tags?: string[];
  importance?: number;
  tier?: MemoryTier;
  namespace?: string;
  chunk_size?: number;
  chunk_overlap?: number;
  /** Attribution */
  provider?: string;
  model_id?: string;
  model_name?: string;
  agent?: string;
}

export interface ResearchSourceResult {
  url: string;
  title: string;
  status: "ingested" | "failed" | "skipped";
  chunks_stored?: number;
  total_chars?: number;
  error?: string;
  parent_id?: string;
}

export interface ResearchResult {
  topic: string;
  queries_run: string[];
  sources_found: number;
  sources_ingested: number;
  sources_failed: number;
  sources_skipped: number;
  total_chunks: number;
  total_chars: number;
  sources: ResearchSourceResult[];
}

/**
 * Research a topic: search the web, find relevant sources, and ingest them.
 *
 * Flow:
 * 1. Generate search queries from the topic
 * 2. Search DuckDuckGo for each query
 * 3. Deduplicate and rank URLs
 * 4. Ingest top N sources
 * 5. Return summary
 */
export async function researchTopic(
  db: DatabaseSync,
  options: ResearchOptions
): Promise<ResearchResult> {
  const {
    topic,
    max_sources = 5,
    max_results_per_query = 10,
  } = options;

  // 1. Build search queries
  const queries = [
    topic,
    ...(options.queries ?? generateQueries(topic)),
  ];
  // Deduplicate queries (case-insensitive)
  const uniqueQueries = [...new Set(queries.map((q) => q.toLowerCase()))].map(
    (q) => queries.find((orig) => orig.toLowerCase() === q)!
  );

  // 2. Search and collect URLs
  const allHits: SearchHit[] = [];
  const seenUrls = new Set<string>();

  for (const query of uniqueQueries) {
    try {
      const hits = await searchWeb(query, max_results_per_query);
      for (const hit of hits) {
        const normalized = normalizeUrl(hit.url);
        if (!seenUrls.has(normalized)) {
          seenUrls.add(normalized);
          allHits.push(hit);
        }
      }
    } catch {
      // Search failure for one query shouldn't abort the whole research
    }
  }

  if (allHits.length === 0) {
    return {
      topic,
      queries_run: uniqueQueries,
      sources_found: 0,
      sources_ingested: 0,
      sources_failed: 0,
      sources_skipped: 0,
      total_chunks: 0,
      total_chars: 0,
      sources: [],
    };
  }

  // 3. Score and rank hits by relevance to topic
  const scored = allHits.map((hit) => ({
    ...hit,
    score: relevanceScore(hit, topic),
  }));
  scored.sort((a, b) => b.score - a.score);

  // 4. Check which URLs are already ingested
  const existingUrls = new Set<string>();
  for (const hit of scored) {
    const rows = db
      .prepare(
        "SELECT id FROM memories WHERE source_uri = ? AND is_active = 1 LIMIT 1"
      )
      .all(hit.url) as Array<{ id: string }>;
    if (rows.length > 0) {
      existingUrls.add(hit.url);
    }
  }

  // 5. Ingest top sources
  const topHits = scored.slice(0, max_sources + existingUrls.size);
  const sources: ResearchSourceResult[] = [];
  let ingested = 0;
  let failed = 0;
  let skipped = 0;
  let totalChunks = 0;
  let totalChars = 0;

  const topicTags = [
    ...(options.tags ?? []),
    ...topic
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3),
  ];

  for (const hit of topHits) {
    if (ingested >= max_sources) break;

    if (existingUrls.has(hit.url)) {
      sources.push({
        url: hit.url,
        title: hit.title,
        status: "skipped",
        error: "Already ingested",
      });
      skipped++;
      continue;
    }

    try {
      const result = await ingestUrl(db, {
        url: hit.url,
        tags: topicTags,
        importance: options.importance,
        tier: options.tier,
        namespace: options.namespace,
        chunk_size: options.chunk_size,
        chunk_overlap: options.chunk_overlap,
        provider: options.provider,
        model_id: options.model_id,
        model_name: options.model_name,
        agent: options.agent,
      });

      sources.push({
        url: result.url,
        title: result.title,
        status: "ingested",
        chunks_stored: result.chunks_stored,
        total_chars: result.total_chars,
        parent_id: result.parent_id,
      });
      ingested++;
      totalChunks += result.chunks_stored;
      totalChars += result.total_chars;
    } catch (err) {
      sources.push({
        url: hit.url,
        title: hit.title,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  return {
    topic,
    queries_run: uniqueQueries,
    sources_found: allHits.length,
    sources_ingested: ingested,
    sources_failed: failed,
    sources_skipped: skipped,
    total_chunks: totalChunks,
    total_chars: totalChars,
    sources,
  };
}

// --- Helpers ---

/** Generate additional search queries from a topic */
function generateQueries(topic: string): string[] {
  return [
    `${topic} guide`,
    `${topic} tutorial`,
    `${topic} explained`,
  ];
}

/** Normalize URL for dedup (strip trailing slash, fragment, common tracking params) */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    u.searchParams.delete("ref");
    let path = u.pathname;
    if (path.endsWith("/") && path.length > 1) {
      path = path.slice(0, -1);
    }
    u.pathname = path;
    return u.toString();
  } catch {
    return url;
  }
}

/** Score a search hit's relevance to the topic (0-1) */
function relevanceScore(hit: SearchHit, topic: string): number {
  const topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const text = `${hit.title} ${hit.snippet}`.toLowerCase();

  // Word overlap
  const matched = topicWords.filter((w) => text.includes(w)).length;
  const wordScore = topicWords.length > 0 ? matched / topicWords.length : 0;

  // Prefer longer snippets (more content likely)
  const snippetScore = Math.min(hit.snippet.length / 200, 1);

  // Prefer known high-quality domains
  const qualityDomains = [
    "wikipedia.org",
    "investopedia.com",
    "docs.",
    "developer.",
    "learn.",
    "edu",
    "medium.com",
    "dev.to",
    "arxiv.org",
  ];
  let domainBonus = 0;
  try {
    const hostname = new URL(hit.url).hostname;
    if (qualityDomains.some((d) => hostname.includes(d))) {
      domainBonus = 0.15;
    }
  } catch {
    // ignore
  }

  return wordScore * 0.5 + snippetScore * 0.2 + domainBonus + 0.15;
}
