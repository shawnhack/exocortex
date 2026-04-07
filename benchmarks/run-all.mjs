#!/usr/bin/env node
/**
 * Exocortex Benchmark Suite
 *
 * Supports: LongMemEval, LoCoMo, MemBench
 * Search: FTS (Porter stemming) + Neural Embeddings (all-MiniLM-L6-v2) + RRF fusion
 *
 * Usage:
 *   node run-all.mjs                          # run all benchmarks
 *   node run-all.mjs --bench longmemeval       # run specific benchmark
 *   node run-all.mjs --bench locomo
 *   node run-all.mjs --bench membench
 *   node run-all.mjs --limit 20                # limit questions per benchmark
 *   node run-all.mjs --no-embed                # FTS-only mode (fast, no model load)
 *   node run-all.mjs --sample 50               # embed only a 50-question sample per benchmark (fast + accurate)
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
const benchArg = args.indexOf("--bench");
const BENCH = benchArg >= 0 ? args[benchArg + 1] : "all";
const USE_EMBEDDINGS = !args.includes("--no-embed");
const sampleArg = args.indexOf("--sample");
const EMBED_SAMPLE = sampleArg >= 0 ? parseInt(args[sampleArg + 1], 10) : 0;

const DB_PATH = path.join(__dirname, `_bench_${process.pid}.db`);
const K_VALUES = [1, 3, 5, 10];

// ---------------------------------------------------------------------------
// Embedding provider (lazy load) + global cache
// ---------------------------------------------------------------------------

let embedProvider = null;
/** Global embedding cache: content hash → Float32Array */
const embeddingCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

async function getProvider() {
  if (!USE_EMBEDDINGS) return null;
  if (embedProvider) return embedProvider;
  const core = await import("../packages/core/dist/index.js");
  embedProvider = await core.getEmbeddingProvider();
  return embedProvider;
}

/** Fast content hash for cache key — first 200 chars is sufficient for uniqueness */
function contentKey(text) {
  return text.slice(0, 200);
}

function cosineSimVec(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Database + search
// ---------------------------------------------------------------------------

function createFreshDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE docs (id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding BLOB);
    CREATE VIRTUAL TABLE docs_fts USING fts5(content, tokenize='porter unicode61');
  `);
  return db;
}

async function ingestDocs(db, docs) {
  const insert = db.prepare("INSERT OR IGNORE INTO docs (id, content, embedding) VALUES (?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO docs_fts (rowid, content) VALUES (?, ?)");
  let rowid = 1;
  const seen = new Set();

  // Batch embed — check cache first, only embed uncached docs
  let embeddings = null;
  if (USE_EMBEDDINGS) {
    const provider = await getProvider();
    if (provider) {
      embeddings = new Map();
      const uncachedTexts = [];
      const uncachedIds = [];

      for (const doc of docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        const key = contentKey(doc.content);
        const cached = embeddingCache.get(key);
        if (cached) {
          embeddings.set(doc.id, cached);
          cacheHits++;
        } else {
          uncachedTexts.push(doc.content.slice(0, 2000));
          uncachedIds.push(doc.id);
          cacheMisses++;
        }
      }
      seen.clear();

      // Batch embed only uncached docs
      if (uncachedTexts.length > 0) {
        const vecs = await provider.embedBatch(uncachedTexts);
        for (let j = 0; j < uncachedIds.length; j++) {
          embeddings.set(uncachedIds[j], vecs[j]);
          embeddingCache.set(contentKey(docs.find(d => d.id === uncachedIds[j]).content), vecs[j]);
        }
      }
    }
  }

  for (const { id, content } of docs) {
    if (seen.has(id)) continue;
    seen.add(id);
    const emb = embeddings?.get(id);
    const embBuf = emb ? Buffer.from(emb.buffer) : null;
    insert.run(id, content, embBuf);
    insertFts.run(rowid, content);
    rowid++;
  }
  return rowid - 1;
}

// Stopwords to remove from FTS queries
const STOPWORDS = new Set(["what", "when", "where", "who", "how", "did", "was", "the", "are", "has", "have",
  "does", "can", "will", "about", "with", "from", "that", "this", "for", "you", "your", "would", "could",
  "should", "some", "any", "been", "being", "more", "also", "into", "than", "then", "there", "their",
  "which", "were", "they", "them", "very", "just", "but", "not", "all", "its", "his", "her", "our",
  "she", "him", "her", "had", "may", "might", "still", "recommend", "suggest", "give", "tell"]);

// Extract proper nouns / entity names from query (capitalized words)
function extractNames(query) {
  const matches = query.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  return [...new Set(matches.map(m => m.toLowerCase()))];
}

async function search(db, query, topK, docs) {
  const results = new Map(); // id → RRF score
  const k = 60; // RRF constant

  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
  const contentWords = words.filter(w => !STOPWORDS.has(w));
  const names = extractNames(query);
  const ftsWordsAnd = contentWords.slice(0, 8).map(w => `"${w}"`).join(" AND ");
  const ftsWordsOr = contentWords.slice(0, 10).map(w => `"${w}"`).join(" OR ");

  let ftsHitCount = 0;

  // Pass 1: AND query (all content words must appear — high precision)
  // Only use AND when query has 3+ content words (too strict for 2-word queries)
  if (ftsWordsAnd && contentWords.length >= 3) {
    try {
      const andRows = db.prepare(
        `SELECT d.id FROM docs_fts fts INNER JOIN docs d ON fts.rowid = d.rowid
         WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`
      ).all(ftsWordsAnd, topK * 2);
      ftsHitCount = andRows.length;
      // AND matches get a precision bonus (1.3x weight)
      andRows.forEach((r, i) => results.set(r.id, (results.get(r.id) || 0) + 1.3 / (k + i + 1)));
    } catch { /* AND can fail if terms don't exist in index */ }
  }

  // Pass 2: OR query (any content word — high recall, lower precision)
  if (ftsWordsOr) {
    try {
      const orRows = db.prepare(
        `SELECT d.id FROM docs_fts fts INNER JOIN docs d ON fts.rowid = d.rowid
         WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`
      ).all(ftsWordsOr, topK * 3);
      if (ftsHitCount === 0) ftsHitCount = orRows.length;
      orRows.forEach((r, i) => results.set(r.id, (results.get(r.id) || 0) + 1 / (k + i + 1)));
    } catch { /* FTS can fail on edge cases */ }
  }


  // 2. Embedding search — adaptive weight based on FTS strength
  if (USE_EMBEDDINGS) {
    const provider = await getProvider();
    if (provider) {
      const qKey = "q:" + contentKey(query);
      let queryVec = embeddingCache.get(qKey);
      if (!queryVec) {
        queryVec = await provider.embed(query);
        embeddingCache.set(qKey, queryVec);
      }
      const scores = [];

      const rows = db.prepare("SELECT id, embedding FROM docs WHERE embedding IS NOT NULL").all();
      for (const row of rows) {
        const docVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        scores.push({ id: row.id, score: cosineSimVec(queryVec, docVec) });
      }
      scores.sort((a, b) => b.score - a.score);

      // Adaptive weighting: if FTS found strong matches, reduce embedding influence
      // If FTS is weak (<3 results), embeddings get full weight
      const embedWeight = ftsHitCount >= 5 ? 0.4 : ftsHitCount >= 3 ? 0.7 : 1.0;
      scores.forEach((s, i) => {
        results.set(s.id, (results.get(s.id) || 0) + embedWeight * (1 / (k + i + 1)));
      });
    }
  }

  return [...results.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computeRecall(retrieved, groundTruth) {
  const gt = new Set(Array.isArray(groundTruth) ? groundTruth : [groundTruth]);
  return retrieved.some(id => gt.has(id)) ? 1 : 0;
}

function computeNDCG(retrieved, groundTruth, k) {
  const gt = new Set(Array.isArray(groundTruth) ? groundTruth : [groundTruth]);
  let dcg = 0;
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (gt.has(retrieved[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(gt.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

// ---------------------------------------------------------------------------
// Benchmark: LongMemEval
// ---------------------------------------------------------------------------

async function runLongMemEval(limit) {
  const dataPath = path.join(__dirname, "longmemeval/longmemeval_s.json");
  if (!fs.existsSync(dataPath)) { console.log("  SKIP: longmemeval_s.json not found"); return null; }
  const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const questions = data.filter(q => !q.question_id?.endsWith("_abs")).slice(0, limit);

  const metrics = { recall: {}, ndcg: {} };
  for (const k of K_VALUES) { metrics.recall[k] = []; metrics.ndcg[k] = []; }
  const typeMetrics = {};

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const db = createFreshDb();
    try {
      const docs = [];
      const seen = new Set();
      for (let i = 0; i < q.haystack_sessions.length; i++) {
        const id = q.haystack_session_ids[i];
        if (seen.has(id)) continue;
        seen.add(id);
        docs.push({ id, content: q.haystack_sessions[i].map(t => `${t.role}: ${t.content}`).join("\n") });
      }
      await ingestDocs(db, docs);
      const retrieved = await search(db, q.question, Math.max(...K_VALUES), docs);

      for (const k of K_VALUES) {
        const topK = retrieved.slice(0, k);
        metrics.recall[k].push(computeRecall(topK, q.answer_session_ids));
        metrics.ndcg[k].push(computeNDCG(topK, q.answer_session_ids, k));
        if (!typeMetrics[q.question_type]) typeMetrics[q.question_type] = {};
        if (!typeMetrics[q.question_type][k]) typeMetrics[q.question_type][k] = [];
        typeMetrics[q.question_type][k].push(computeRecall(topK, q.answer_session_ids));
      }
    } finally { db.close(); }
    if ((qi + 1) % 50 === 0) process.stdout.write(`\r  ${qi + 1}/${questions.length}`);
  }

  return { name: "LongMemEval", questions: questions.length, metrics, typeMetrics };
}

// ---------------------------------------------------------------------------
// Benchmark: LoCoMo
// ---------------------------------------------------------------------------

async function runLoCoMo(limit) {
  const dataPath = path.join(__dirname, "longmemeval/locomo10.json");
  if (!fs.existsSync(dataPath)) { console.log("  SKIP: locomo10.json not found"); return null; }
  const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const CAT_NAMES = { 1: "single-hop", 2: "temporal", 3: "open-domain", 4: "multi-hop", 5: "adversarial" };

  const metrics = { recall: {}, ndcg: {} };
  for (const k of K_VALUES) { metrics.recall[k] = []; metrics.ndcg[k] = []; }
  const typeMetrics = {};
  let totalQA = 0;

  for (const convKey of Object.keys(data)) {
    const conv = data[convKey];
    const convo = conv.conversation;
    const docs = [];
    const sessionKeys = Object.keys(convo).filter(k => /^session_\d+$/.test(k))
      .sort((a, b) => parseInt(a.split("_")[1]) - parseInt(b.split("_")[1]));

    for (const sk of sessionKeys) {
      const turns = convo[sk];
      if (!Array.isArray(turns)) continue;
      docs.push({ id: `D${sk.split("_")[1]}`, content: turns.map(t => `${t.speaker}: ${t.text}`).join("\n") });
    }

    const db = createFreshDb();
    try {
      await ingestDocs(db, docs);
      const qaSlice = conv.qa.slice(0, limit === Infinity ? Infinity : Math.ceil(limit / 10));

      for (const qa of qaSlice) {
        const evidenceSessions = [...new Set(qa.evidence.map(e => e.split(":")[0]))];
        const retrieved = await search(db, qa.question, Math.max(...K_VALUES), docs);
        const catName = CAT_NAMES[qa.category] || `cat${qa.category}`;

        for (const k of K_VALUES) {
          const topK = retrieved.slice(0, k);
          metrics.recall[k].push(computeRecall(topK, evidenceSessions));
          metrics.ndcg[k].push(computeNDCG(topK, evidenceSessions, k));
          if (!typeMetrics[catName]) typeMetrics[catName] = {};
          if (!typeMetrics[catName][k]) typeMetrics[catName][k] = [];
          typeMetrics[catName][k].push(computeRecall(topK, evidenceSessions));
        }
        totalQA++;
      }
    } finally { db.close(); }
  }

  return { name: "LoCoMo", questions: totalQA, metrics, typeMetrics };
}

// ---------------------------------------------------------------------------
// Benchmark: MemBench
// ---------------------------------------------------------------------------

async function runMemBench(limit) {
  const dataDir = path.join(__dirname, "membench/data");
  if (!fs.existsSync(dataDir)) { console.log("  SKIP: membench/data not found"); return null; }

  const categories = ["simple", "highlevel", "knowledge_update", "comparative", "conditional", "noisy", "aggregative"];
  const metrics = { recall: {}, ndcg: {} };
  for (const k of K_VALUES) { metrics.recall[k] = []; metrics.ndcg[k] = []; }
  const typeMetrics = {};
  let totalQA = 0;

  for (const cat of categories) {
    const filePath = path.join(dataDir, `${cat}.json`);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const roles = data.roles || [];
    const perCatLimit = Math.min(roles.length, limit === Infinity ? 50 : Math.ceil(limit / categories.length));

    for (let ri = 0; ri < perCatLimit; ri++) {
      const role = roles[ri];
      if (!role.QA || !role.message_list) continue;

      const docs = [];
      let turnIdx = 0;
      const turnToSession = new Map();
      for (let si = 0; si < role.message_list.length; si++) {
        const session = role.message_list[si];
        docs.push({ id: `S${si}`, content: session.map(t => `User: ${t.user_message}\nAssistant: ${t.assistant_message}`).join("\n") });
        for (let ti = 0; ti < session.length; ti++) { turnToSession.set(turnIdx, `S${si}`); turnIdx++; }
      }

      const qa = role.QA;
      const targetSessions = [...new Set(qa.target_step_id.flat().map(t => turnToSession.get(t)).filter(Boolean))];
      if (targetSessions.length === 0) continue;

      const db = createFreshDb();
      try {
        await ingestDocs(db, docs);
        const retrieved = await search(db, qa.question, Math.max(...K_VALUES), docs);

        for (const k of K_VALUES) {
          const topK = retrieved.slice(0, k);
          metrics.recall[k].push(computeRecall(topK, targetSessions));
          metrics.ndcg[k].push(computeNDCG(topK, targetSessions, k));
          if (!typeMetrics[cat]) typeMetrics[cat] = {};
          if (!typeMetrics[cat][k]) typeMetrics[cat][k] = [];
          typeMetrics[cat][k].push(computeRecall(topK, targetSessions));
        }
        totalQA++;
      } finally { db.close(); }
    }
  }

  return { name: "MemBench", questions: totalQA, metrics, typeMetrics };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(result) {
  if (!result) return null;
  const { name, questions, metrics, typeMetrics } = result;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${name} — ${questions} questions`);
  console.log("=".repeat(50));

  console.log("\n  Overall:");
  for (const k of K_VALUES) {
    const r = metrics.recall[k];
    const n = metrics.ndcg[k];
    const recall = r.length > 0 ? (r.reduce((a, b) => a + b, 0) / r.length * 100).toFixed(1) : "N/A";
    const ndcg = n.length > 0 ? (n.reduce((a, b) => a + b, 0) / n.length * 100).toFixed(1) : "N/A";
    console.log(`    Recall@${String(k).padEnd(2)}: ${recall}%   NDCG@${String(k).padEnd(2)}: ${ndcg}%`);
  }

  if (Object.keys(typeMetrics).length > 0) {
    console.log("\n  By category:");
    for (const [type, m] of Object.entries(typeMetrics).sort()) {
      const r5 = m[5] ? (m[5].reduce((a, b) => a + b, 0) / m[5].length * 100).toFixed(1) : "N/A";
      const r10 = m[10] ? (m[10].reduce((a, b) => a + b, 0) / m[10].length * 100).toFixed(1) : "N/A";
      const n = m[5]?.length || 0;
      console.log(`    ${type.padEnd(28)} R@5: ${r5}%  R@10: ${r10}%  (n=${n})`);
    }
  }

  return {
    name, questions,
    overall: Object.fromEntries(K_VALUES.map(k => [`k${k}`, {
      recall: parseFloat((metrics.recall[k].reduce((a, b) => a + b, 0) / metrics.recall[k].length * 100).toFixed(1)),
      ndcg: parseFloat((metrics.ndcg[k].reduce((a, b) => a + b, 0) / metrics.ndcg[k].length * 100).toFixed(1)),
    }])),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const mode = USE_EMBEDDINGS ? "FTS + Embeddings (hybrid RRF)" : "FTS only";
console.log(`Exocortex Benchmark Suite`);
console.log(`Mode: ${mode} | Limit: ${LIMIT === Infinity ? "none" : LIMIT}\n`);

if (USE_EMBEDDINGS) {
  process.stdout.write("Loading embedding model...");
  await getProvider();
  console.log(" ready\n");
}

const results = [];
const startTime = Date.now();

if (BENCH === "all" || BENCH === "longmemeval") {
  process.stdout.write("Running LongMemEval...\n");
  results.push(printReport(await runLongMemEval(LIMIT)));
}

if (BENCH === "all" || BENCH === "locomo") {
  process.stdout.write("Running LoCoMo...\n");
  results.push(printReport(await runLoCoMo(LIMIT)));
}

if (BENCH === "all" || BENCH === "membench") {
  process.stdout.write("Running MemBench...\n");
  results.push(printReport(await runMemBench(LIMIT)));
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(`\n${"=".repeat(50)}`);
console.log("  SUMMARY");
console.log("=".repeat(50));
console.log(`  Mode: ${mode}`);
console.log(`\n  ${"Benchmark".padEnd(16)} ${"R@5".padEnd(8)} ${"R@10".padEnd(8)} Questions`);
console.log(`  ${"-".repeat(16)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(9)}`);
for (const r of results.filter(Boolean)) {
  console.log(`  ${r.name.padEnd(16)} ${(r.overall.k5.recall + "%").padEnd(8)} ${(r.overall.k10.recall + "%").padEnd(8)} ${r.questions}`);
}
console.log(`\n  Total time: ${elapsed}s`);
if (USE_EMBEDDINGS) {
  const total = cacheHits + cacheMisses;
  const hitRate = total > 0 ? (cacheHits / total * 100).toFixed(1) : "0";
  console.log(`  Embedding cache: ${cacheHits} hits / ${total} total (${hitRate}% hit rate)`);
}

const outPath = path.join(__dirname, `results_${USE_EMBEDDINGS ? "hybrid" : "fts"}_${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  date: new Date().toISOString(), mode, elapsed_s: parseFloat(elapsed),
  results: results.filter(Boolean),
}, null, 2));
console.log(`  Results: ${outPath}\n`);

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
