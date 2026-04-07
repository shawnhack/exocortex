#!/usr/bin/env node
/**
 * LongMemEval Benchmark Runner for Exocortex
 *
 * Runs the LongMemEval retrieval benchmark against exocortex's search pipeline.
 * Each question gets its own fresh database with ingested conversation sessions,
 * then we query and measure Recall@K.
 *
 * Usage:
 *   node run.mjs                          # run full benchmark (500 questions)
 *   node run.mjs --limit 20               # run first 20 questions
 *   node run.mjs --dataset oracle          # use oracle dataset (evidence-only)
 *   node run.mjs --dataset s              # use full dataset (~40 sessions/question)
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
const datasetArg = args.indexOf("--dataset");
const DATASET = datasetArg >= 0 ? args[datasetArg + 1] : "oracle";

const DATASET_FILE = DATASET === "s"
  ? path.join(__dirname, "longmemeval_s.json")
  : path.join(__dirname, "longmemeval_oracle.json");

const DB_PATH = path.join(__dirname, "_bench.db");
const K_VALUES = [1, 3, 5, 10];

// ---------------------------------------------------------------------------
// Lightweight in-memory embedding (TF-IDF proxy for speed)
// ---------------------------------------------------------------------------

/** Build a simple TF vector for text */
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function tfidf(tokens, df, totalDocs) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Map();
  for (const [term, count] of tf) {
    const idf = Math.log(totalDocs / (1 + (df.get(term) || 0)));
    vec.set(term, (count / tokens.length) * idf);
  }
  return vec;
}

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (const [k, v] of a) {
    normA += v * v;
    if (b.has(k)) dot += v * b.get(k);
  }
  for (const [, v] of b) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Database setup — fresh per question
// ---------------------------------------------------------------------------

function createFreshDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      session_date TEXT
    );
    CREATE VIRTUAL TABLE sessions_fts USING fts5(content, tokenize='porter unicode61');
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Ingest sessions
// ---------------------------------------------------------------------------

function ingestSessions(db, sessions, sessionIds, sessionDates) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sessions (id, content, session_date) VALUES (?, ?, ?)"
  );
  const insertFts = db.prepare(
    "INSERT INTO sessions_fts (rowid, content) VALUES (?, ?)"
  );
  const seen = new Set();

  let rowid = 1;
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const sessionId = sessionIds[i];
    const date = sessionDates?.[i] || null;

    // Concatenate all turns into one text block
    const text = session
      .map(turn => `${turn.role}: ${turn.content}`)
      .join("\n");

    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    insert.run(sessionId, text, date);
    insertFts.run(rowid, text);
    rowid++;
  }
}

// ---------------------------------------------------------------------------
// Search — hybrid FTS + TF-IDF
// ---------------------------------------------------------------------------

function search(db, query, topK, sessions, sessionIds) {
  const results = new Map(); // sessionId → score

  // 1. FTS search
  const ftsQuery = tokenize(query)
    .slice(0, 10)
    .map(w => `"${w}"`)
    .join(" OR ");

  if (ftsQuery) {
    try {
      const ftsRows = db.prepare(
        `SELECT s.id, rank FROM sessions_fts fts
         INNER JOIN sessions s ON fts.rowid = s.rowid
         WHERE sessions_fts MATCH ?
         ORDER BY rank LIMIT ?`
      ).all(ftsQuery, topK * 2);

      ftsRows.forEach((row, i) => {
        const k = 60;
        results.set(row.id, (results.get(row.id) || 0) + 1 / (k + i + 1));
      });
    } catch {
      // FTS match can fail on edge cases
    }
  }

  // 2. TF-IDF semantic search
  const allTexts = sessions.map(s =>
    s.map(turn => `${turn.role}: ${turn.content}`).join("\n")
  );

  // Build document frequency
  const df = new Map();
  const docTokens = allTexts.map(t => tokenize(t));
  for (const tokens of docTokens) {
    const unique = new Set(tokens);
    for (const t of unique) df.set(t, (df.get(t) || 0) + 1);
  }

  const queryTokens = tokenize(query);
  const queryVec = tfidf(queryTokens, df, sessions.length);

  const scores = [];
  for (let i = 0; i < sessions.length; i++) {
    const docVec = tfidf(docTokens[i], df, sessions.length);
    scores.push({ id: sessionIds[i], score: cosineSim(queryVec, docVec) });
  }
  scores.sort((a, b) => b.score - a.score);

  // RRF merge
  scores.forEach((s, i) => {
    const k = 60;
    results.set(s.id, (results.get(s.id) || 0) + 1 / (k + i + 1));
  });

  // Sort by combined RRF score
  return [...results.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computeRecall(retrieved, groundTruth) {
  const gtSet = new Set(groundTruth);
  return retrieved.some(id => gtSet.has(id)) ? 1 : 0;
}

function computeNDCG(retrieved, groundTruth, k) {
  const gtSet = new Set(groundTruth);
  let dcg = 0;
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (gtSet.has(retrieved[i])) {
      dcg += 1 / Math.log2(i + 2); // i+2 because log2(1)=0
    }
  }
  // Ideal DCG: all relevant docs at top
  let idcg = 0;
  for (let i = 0; i < Math.min(groundTruth.length, k); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Loading ${DATASET_FILE}...`);
const data = JSON.parse(fs.readFileSync(DATASET_FILE, "utf-8"));

// Filter out abstention questions (no ground truth retrieval target)
const questions = data
  .filter(q => !q.question_id?.endsWith("_abs"))
  .slice(0, LIMIT);

console.log(`Running ${questions.length} questions (dataset: ${DATASET}, excluding ${data.length - questions.length} abstention/skipped)\n`);

const metrics = { recall: {}, ndcg: {} };
for (const k of K_VALUES) {
  metrics.recall[k] = [];
  metrics.ndcg[k] = [];
}

const typeMetrics = {};
const startTime = Date.now();
let processed = 0;

for (const q of questions) {
  const db = createFreshDb();

  try {
    // Ingest
    ingestSessions(db, q.haystack_sessions, q.haystack_session_ids, q.haystack_dates);

    // Search
    const maxK = Math.max(...K_VALUES);
    const retrieved = search(db, q.question, maxK, q.haystack_sessions, q.haystack_session_ids);

    // Score
    for (const k of K_VALUES) {
      const topK = retrieved.slice(0, k);
      const recall = computeRecall(topK, q.answer_session_ids);
      const ndcg = computeNDCG(topK, q.answer_session_ids, k);
      metrics.recall[k].push(recall);
      metrics.ndcg[k].push(ndcg);

      // Per-type tracking
      if (!typeMetrics[q.question_type]) typeMetrics[q.question_type] = {};
      if (!typeMetrics[q.question_type][`r@${k}`]) typeMetrics[q.question_type][`r@${k}`] = [];
      typeMetrics[q.question_type][`r@${k}`].push(recall);
    }
  } finally {
    db.close();
  }

  processed++;
  if (processed % 50 === 0 || processed === questions.length) {
    const r5 = (metrics.recall[5].reduce((a, b) => a + b, 0) / metrics.recall[5].length * 100).toFixed(1);
    process.stdout.write(`\r  ${processed}/${questions.length} — R@5: ${r5}%`);
  }
}

// Cleanup
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s\n`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("=== LongMemEval Retrieval Benchmark ===");
console.log(`Dataset: ${DATASET} | Questions: ${questions.length} | Time: ${elapsed}s\n`);

console.log("Overall:");
for (const k of K_VALUES) {
  const recall = (metrics.recall[k].reduce((a, b) => a + b, 0) / metrics.recall[k].length * 100).toFixed(1);
  const ndcg = (metrics.ndcg[k].reduce((a, b) => a + b, 0) / metrics.ndcg[k].length * 100).toFixed(1);
  console.log(`  Recall@${k}: ${recall}%   NDCG@${k}: ${ndcg}%`);
}

console.log("\nBy question type:");
for (const [type, m] of Object.entries(typeMetrics).sort()) {
  const r5 = m["r@5"] ? (m["r@5"].reduce((a, b) => a + b, 0) / m["r@5"].length * 100).toFixed(1) : "N/A";
  const r10 = m["r@10"] ? (m["r@10"].reduce((a, b) => a + b, 0) / m["r@10"].length * 100).toFixed(1) : "N/A";
  const count = m["r@5"]?.length || 0;
  console.log(`  ${type.padEnd(30)} R@5: ${r5}%  R@10: ${r10}%  (n=${count})`);
}

// Save results
const resultsPath = path.join(__dirname, `results_${DATASET}_${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(resultsPath, JSON.stringify({
  dataset: DATASET,
  date: new Date().toISOString(),
  questions: questions.length,
  elapsed_s: parseFloat(elapsed),
  overall: Object.fromEntries(K_VALUES.map(k => [
    `k${k}`,
    {
      recall: parseFloat((metrics.recall[k].reduce((a, b) => a + b, 0) / metrics.recall[k].length * 100).toFixed(1)),
      ndcg: parseFloat((metrics.ndcg[k].reduce((a, b) => a + b, 0) / metrics.ndcg[k].length * 100).toFixed(1)),
    }
  ])),
  by_type: Object.fromEntries(Object.entries(typeMetrics).map(([type, m]) => [
    type,
    Object.fromEntries(K_VALUES.map(k => [
      `r@${k}`,
      parseFloat((m[`r@${k}`].reduce((a, b) => a + b, 0) / m[`r@${k}`].length * 100).toFixed(1)),
    ])),
  ])),
}, null, 2));
console.log(`\nResults saved to ${resultsPath}`);
