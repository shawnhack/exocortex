#!/usr/bin/env node

/**
 * Claude Code SessionStart hook — loads relevant Exocortex context
 * for the current project at session start.
 *
 * Queries the database directly (no HTTP dependency) for:
 * - Recent project-related memories (last 7 days)
 * - Active goals
 * - Recent decisions
 *
 * Outputs compact context as additionalContext for Claude.
 * Uses a token budget (~1500 tokens) to keep context lean.
 */

import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.join(os.homedir(), ".exocortex", "exocortex.db");
const TOKEN_BUDGET = 3000;
const TRUNCATE_LEN = 120;

// Quality filter clause — NULL check ensures pre-migration memories aren't excluded
const QUALITY_FILTER = "AND (m.quality_score IS NULL OR m.quality_score >= 0.25)";

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * ISO timestamp of the previous session-orient invocation, or null if none.
 * Used by the cross-session diff section to scope "what changed since last
 * time you were here." Reads from access_log entries this hook itself wrote
 * during prior runs.
 */
function getLastSessionTimestamp(db) {
  try {
    const row = db
      .prepare(
        "SELECT MAX(accessed_at) as ts FROM access_log WHERE query = 'session-orient'"
      )
      .get();
    return row?.ts || null;
  } catch {
    return null;
  }
}

// Tags that show up in session-summary memory dumps but are too generic to
// be useful keywords for relevance scoring (they'd match almost everything).
const NOISE_TAGS = new Set([
  "session-summary", "summary", "outcome", "operations",
  "goal-progress", "goal-progress-implicit", "task-summary",
  "run-summary", "audit-record", "bridging-memory",
]);

function buildContextKeywords(cwd, db) {
  const keywords = new Map();
  const projectName = path.basename(cwd).toLowerCase();
  keywords.set(projectName, 5);

  // Extract deps from package.json
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name) {
        const pkgName = pkg.name.toLowerCase();
        if (!keywords.has(pkgName) || keywords.get(pkgName) < 4) {
          keywords.set(pkgName, 4);
        }
      }
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const dep of Object.keys(allDeps)) {
        const name = dep.replace(/^@[^/]+\//, "").toLowerCase();
        if (name.length >= 3 && !keywords.has(name)) {
          keywords.set(name, 1);
        }
      }
    }
  } catch {}

  // Extract words from recent git log subjects
  try {
    const log = execSync("git log --oneline -5 --format=%s", {
      cwd,
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "add", "fix", "update", "remove"]);
    for (const line of log.split("\n")) {
      for (const word of line.toLowerCase().split(/[\s\-_:,/]+/)) {
        if (word.length >= 3 && !STOP.has(word) && !keywords.has(word)) {
          keywords.set(word, 2);
        }
      }
    }
  } catch {}

  // Pull tags from memories created in the last 7 days. This widens the
  // keyword pool beyond the current cwd — important for cross-repo agentic
  // work where the cwd is just a launching pad and the actual session topic
  // (security, clerk, auth, etc.) lives in tags from prior memories.
  if (db) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const tagRows = db
        .prepare(
          `SELECT mt.tag, COUNT(*) as n FROM memory_tags mt
           INNER JOIN memories m ON mt.memory_id = m.id
           WHERE m.is_active = 1 AND m.created_at >= ?
           GROUP BY mt.tag
           ORDER BY n DESC
           LIMIT 50`
        )
        .all(sevenDaysAgo);
      for (const { tag, n } of tagRows) {
        if (NOISE_TAGS.has(tag)) continue;
        if (n < 2) continue; // require at least 2 occurrences to be a "topic"
        const lower = tag.toLowerCase();
        if (lower.length < 3) continue;
        if (!keywords.has(lower)) {
          // Weight 1-3 based on frequency, capped to not dominate cwd-derived signals
          keywords.set(lower, Math.min(3, Math.ceil(n / 5)));
        }
      }
    } catch {}
  }

  return keywords;
}

function scoreRelevance(content, keywords) {
  const lower = content.toLowerCase();
  let score = 0;
  for (const [kw, weight] of keywords) {
    if (lower.includes(kw)) score += weight;
  }
  return score;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    return;
  }

  const cwd = hookData.cwd;
  if (!cwd) return;

  // Don't run if DB doesn't exist
  if (!fs.existsSync(DB_PATH)) return;

  // Extract project name from CWD
  const projectName = path.basename(cwd).toLowerCase();

  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA busy_timeout = 1000");
  } catch (err) {
    process.stderr.write("session-orient: DB connection failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
    return;
  }

  // candidateSections: { name, priority, content }
  // Priority order: soul/identity → goals → stalled-goals → decisions → threads → recent → techniques → entities → contradictions → facts → skills → self-model
  const candidateSections = [];
  const surfacedIds = new Set();

  try {
    const contextKeywords = buildContextKeywords(cwd, db);
    // Capture last-session timestamp BEFORE this run logs new access entries.
    const lastSessionTs = getLastSessionTimestamp(db);

    // -1. Action items (priority 0, pushed FIRST so it always lands at top).
    // Surfaces memories the user explicitly tagged as needing attention next
    // session — pending/in-progress/blocked/next-action/waiting-on. Larger
    // excerpt cap (300 chars vs 120) because action items lose meaning when
    // truncated to "Pending CVE fixes — STATUS UPDATE 2026-04-18 ~13:10 ET..."
    try {
      const actionThirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const actionRows = db
        .prepare(
          `SELECT DISTINCT m.id, m.content, m.created_at,
             GROUP_CONCAT(DISTINCT mt2.tag) as tags
           FROM memories m
           INNER JOIN memory_tags mt ON m.id = mt.memory_id
           LEFT JOIN memory_tags mt2 ON m.id = mt2.memory_id
           WHERE mt.tag IN ('pending', 'blocked', 'next-action', 'waiting-on')
             AND m.is_active = 1
             AND m.parent_id IS NULL
             AND m.created_at >= ?
           GROUP BY m.id
           ORDER BY m.importance DESC, m.created_at DESC
           LIMIT 5`
        )
        .all(actionThirtyDaysAgo);

      if (actionRows.length > 0) {
        for (const m of actionRows) surfacedIds.add(m.id);
        const lines = actionRows.map((m) => {
          // Pull only the action-relevant tags from the comma-separated list
          const actionTagSet = new Set(["pending", "blocked", "next-action", "waiting-on"]);
          const tags = (m.tags || "").split(",").filter((t) => actionTagSet.has(t));
          const tagStr = tags.length > 0 ? ` [${tags.join(",")}]` : "";
          const excerpt = truncate(m.content, 300);
          const date = m.created_at.split("T")[0];
          return `- ${excerpt}${tagStr} (${date})`;
        });
        candidateSections.push({
          name: "action-items",
          priority: 0,
          content: `**Action items waiting on you:**\n${lines.join("\n")}`,
        });
      }
    } catch {}

    // -0.5. Cross-session diff (priority 0). "Since you were last here" —
    // counts memories created since lastSessionTs, surfaces top tags + alert
    // count + sentinel run count. Only renders if last session was 2h+ ago
    // (otherwise it's the same session, nothing meaningful changed).
    if (lastSessionTs) {
      try {
        const lastTs = new Date(lastSessionTs.replace(" ", "T") + "Z");
        const hoursSince = (Date.now() - lastTs.getTime()) / (1000 * 60 * 60);
        if (hoursSince >= 2) {
          const newCountRow = db
            .prepare(
              `SELECT COUNT(*) as n FROM memories m
               WHERE m.created_at > ? AND m.is_active = 1`
            )
            .get(lastSessionTs);
          const newCount = newCountRow?.n || 0;

          if (newCount > 0) {
            // Top non-noise tags among the new memories
            const topTagRows = db
              .prepare(
                `SELECT mt.tag, COUNT(*) as n FROM memory_tags mt
                 INNER JOIN memories m ON mt.memory_id = m.id
                 WHERE m.created_at > ? AND m.is_active = 1
                 GROUP BY mt.tag ORDER BY n DESC LIMIT 10`
              )
              .all(lastSessionTs);
            const topTags = topTagRows
              .filter((r) => !NOISE_TAGS.has(r.tag) && r.n >= 2)
              .slice(0, 5)
              .map((r) => `${r.tag} (${r.n})`);

            // Alert-tagged memories among the new ones — surface specifically
            const alertRow = db
              .prepare(
                `SELECT COUNT(DISTINCT m.id) as n FROM memories m
                 INNER JOIN memory_tags mt ON m.id = mt.memory_id
                 WHERE mt.tag = 'alert' AND m.created_at > ? AND m.is_active = 1`
              )
              .get(lastSessionTs);
            const alertCount = alertRow?.n || 0;

            // Sentinel runs — count memories with sentinel:* tags
            const sentinelRow = db
              .prepare(
                `SELECT COUNT(DISTINCT m.id) as n FROM memories m
                 INNER JOIN memory_tags mt ON m.id = mt.memory_id
                 WHERE mt.tag LIKE 'sentinel%' AND m.created_at > ? AND m.is_active = 1`
              )
              .get(lastSessionTs);
            const sentinelCount = sentinelRow?.n || 0;

            const hoursLabel =
              hoursSince < 24
                ? `${Math.round(hoursSince)}h ago`
                : `${Math.round(hoursSince / 24)}d ago`;
            const lines = [`- ${newCount} new memories`];
            if (topTags.length > 0) lines.push(`- top tags: ${topTags.join(", ")}`);
            if (alertCount > 0) lines.push(`- ⚠ ${alertCount} alert${alertCount === 1 ? "" : "s"}`);
            if (sentinelCount > 0) lines.push(`- ${sentinelCount} sentinel job report${sentinelCount === 1 ? "" : "s"}`);

            candidateSections.push({
              name: "diff",
              priority: 0,
              content: `**Since last session (${hoursLabel}):**\n${lines.join("\n")}`,
            });
          }
        }
      } catch {}
    }

    // 0. Soul + Identity (priority 0 — always included, never filtered by relevance)
    try {
      // Get one soul + one identity (separate queries to guarantee both)
      const soulIdentity = [];
      for (const tag of ["soul", "identity"]) {
        const row = db
          .prepare(
            `SELECT DISTINCT m.id, m.content
             FROM memories m
             INNER JOIN memory_tags mt ON m.id = mt.memory_id
             WHERE mt.tag = ?
               AND m.is_active = 1
               AND m.parent_id IS NULL
               AND m.content NOT LIKE '%Consolidated summary of%'
             ORDER BY m.importance DESC, m.created_at DESC
             LIMIT 1`
          )
          .get(tag);
        if (row) soulIdentity.push(row);
      }

      if (soulIdentity.length > 0) {
        for (const m of soulIdentity) surfacedIds.add(m.id);
        // Include full soul and identity content — these are foundational documents
        const fullContent = soulIdentity.map((m) => m.content).join("\n\n");
        candidateSections.push({
          name: "soul-identity",
          priority: 0,
          content: `**Soul & Identity:**\n${fullContent}`,
        });
      }
    } catch {}

    // 1. Active goals (priority 0 — always included)
    const goals = db
      .prepare(
        `SELECT id, title, priority, deadline, metadata
         FROM goals
         WHERE status = 'active'
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC
         LIMIT 5`
      )
      .all();

    if (goals.length > 0) {
      const lines = goals.map((g) => {
        let line = `- ${g.title}`;
        if (g.priority !== "medium") line += ` [${g.priority}]`;
        if (g.deadline) line += ` (due: ${g.deadline})`;
        try {
          const meta = JSON.parse(g.metadata || "{}");
          const milestones = meta.milestones;
          if (Array.isArray(milestones) && milestones.length > 0) {
            const done = milestones.filter((m) => m.status === "completed").length;
            line += ` — ${done}/${milestones.length} milestones`;
          }
        } catch {}
        return line;
      });
      candidateSections.push({ name: "goals", priority: 0, content: `**Active goals:**\n${lines.join("\n")}` });
    }

    // 1b. Stalled goals (priority 1 — between goals and decisions)
    try {
      const stallDays = 7;
      const stallCutoff = new Date(Date.now() - stallDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", "");

      const activeGoals = db
        .prepare(
          `SELECT id, title, updated_at FROM goals WHERE status = 'active'`
        )
        .all();

      const stalledGoals = activeGoals.filter((g) => {
        // Check if goal was updated recently
        if (g.updated_at >= stallCutoff) return false;
        // Check for any recent progress memory
        const recentProgress = db
          .prepare(
            `SELECT COUNT(*) as count FROM memories m
             INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag = 'goal-progress'
             WHERE m.is_active = 1
               AND m.metadata LIKE ?
               AND m.created_at >= ?`
          )
          .get(`%"goal_id":"${g.id}"%`, stallCutoff);
        return !recentProgress || recentProgress.count === 0;
      });

      if (stalledGoals.length > 0) {
        const lines = stalledGoals.map((g) => {
          const updatedDate = new Date(g.updated_at + "Z");
          const daysSinceUpdate = Math.floor((Date.now() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
          return `- ${g.title} (stalled ${daysSinceUpdate}d)`;
        });
        candidateSections.push({
          name: "stalled-goals",
          priority: 1,
          content: `**Stalled goals:**\n${lines.join("\n")}`,
        });
      }
    } catch {}

    // 1c. Unresolved alerts from self-audit (priority 1 — surface immediately)
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const auditReports = db
        .prepare(
          `SELECT m.content, m.created_at
           FROM memories m
           INNER JOIN memory_tags mt ON m.id = mt.memory_id
           WHERE mt.tag = 'self-audit' AND m.is_active = 1 AND m.created_at >= ?
           ORDER BY m.created_at DESC
           LIMIT 1`
        )
        .all(threeDaysAgo);

      if (auditReports.length > 0) {
        const report = auditReports[0].content;
        // Extract ALERT lines and "Issues requiring attention" section
        const alertLines = report.split("\n").filter((l) => l.includes("ALERT:"));
        const issuesMatch = report.match(/Issues requiring attention:\n([\s\S]*?)(?:\n\n|\s*$)/);
        const issues = issuesMatch ? issuesMatch[1].trim().split("\n").filter((l) => l.trim().startsWith("-")) : [];

        if (alertLines.length > 0 || issues.length > 0) {
          const lines = [];
          for (const a of alertLines) lines.push(a.trim());
          for (const i of issues) lines.push(i.trim());
          candidateSections.push({
            name: "alerts",
            priority: 1,
            content: `**Sentinel alerts (from self-audit):**\n${lines.join("\n")}`,
          });
        }
      }
    } catch {}

    // 2. Recent decisions (priority 2 — shifted for stalled goals)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const decisionCandidates = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = 'decision' AND m.is_active = 1 AND m.created_at >= ?
           ${QUALITY_FILTER}
         ORDER BY m.created_at DESC
         LIMIT 8`
      )
      .all(thirtyDaysAgo);

    if (decisionCandidates.length > 0) {
      const scored = decisionCandidates.map((m) => ({
        ...m,
        relevance: scoreRelevance(m.content, contextKeywords),
      }));
      scored.sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        return b.created_at > a.created_at ? 1 : -1;
      });
      const top = scored.filter((m) => m.relevance > 0).slice(0, 2);
      if (top.length > 0) {
        for (const m of top) surfacedIds.add(m.id);
        const rawEntries = top.map((m) => ({ content: m.content, date: m.created_at.split("T")[0] }));
        candidateSections.push({
          name: "decisions", priority: 2,
          header: "**Recent decisions:**", rawEntries,
          content: renderEntrySection("**Recent decisions:**", rawEntries, TRUNCATE_LEN),
        });
      }
    }

    // 3. Open threads (priority 2)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const threadCandidates = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag IN ('plan', 'todo', 'next-steps', 'in-progress')
           AND m.is_active = 1
           AND m.superseded_by IS NULL
           AND m.created_at >= ?
           ${QUALITY_FILTER}
         ORDER BY m.created_at DESC
         LIMIT 6`
      )
      .all(fourteenDaysAgo);

    if (threadCandidates.length > 0) {
      const scored = threadCandidates.map((m) => ({
        ...m,
        relevance: scoreRelevance(m.content, contextKeywords),
      }));
      scored.sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        return b.created_at > a.created_at ? 1 : -1;
      });
      const top = scored.filter((m) => m.relevance > 0).slice(0, 2);
      if (top.length > 0) {
        for (const m of top) surfacedIds.add(m.id);
        const rawEntries = top.map((m) => ({ content: m.content, date: m.created_at.split("T")[0] }));
        candidateSections.push({
          name: "threads", priority: 3,
          header: "**Open threads:**", rawEntries,
          content: renderEntrySection("**Open threads:**", rawEntries, TRUNCATE_LEN),
        });
      }
    }

    // 4. Recent project memories (priority 3)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const recentMemories = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.importance, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = ? AND m.is_active = 1 AND m.created_at >= ?
           ${QUALITY_FILTER}
         ORDER BY m.created_at DESC
         LIMIT 3`
      )
      .all(projectName, sevenDaysAgo);

    if (recentMemories.length > 0) {
      for (const m of recentMemories) surfacedIds.add(m.id);
      const rawEntries = recentMemories.map((m) => ({ content: m.content, date: m.created_at.split("T")[0] }));
      const recentHeader = `**Recent (${projectName}):**`;
      candidateSections.push({
        name: "recent", priority: 4,
        header: recentHeader, rawEntries,
        content: renderEntrySection(recentHeader, rawEntries, TRUNCATE_LEN),
      });
    }

    // 5. Permanent knowledge — semantic + procedural tier memories (priority 4)
    // This catches both tag-based techniques AND tier-based knowledge
    const knowledgeCandidates = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.importance, m.tier, m.created_at
         FROM memories m
         WHERE m.is_active = 1
           AND m.parent_id IS NULL
           AND (m.tier IN ('semantic', 'procedural') OR EXISTS (
             SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = 'technique'
           ))
           ${QUALITY_FILTER}
         ORDER BY m.importance DESC, m.access_count DESC, m.created_at DESC
         LIMIT 20`
      )
      .all();

    if (knowledgeCandidates.length > 0) {
      const scored = knowledgeCandidates
        .filter((m) => !surfacedIds.has(m.id)) // deduplicate against earlier sections
        .filter((m) => !m.content.startsWith("[Consolidated summary")) // consolidated summaries aren't actionable knowledge
        .map((m) => ({
          ...m,
          relevance: scoreRelevance(m.content, contextKeywords),
        }));
      scored.sort((a, b) => {
        const aRelevant = a.relevance > 0 ? 1 : 0;
        const bRelevant = b.relevance > 0 ? 1 : 0;
        if (bRelevant !== aRelevant) return bRelevant - aRelevant;
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.created_at > a.created_at ? 1 : -1;
      });
      const top = scored.filter((m) => m.relevance > 0).slice(0, 4);
      if (top.length > 0) {
        for (const m of top) surfacedIds.add(m.id);
        const rawEntries = top.map((m) => ({ content: m.content }));
        candidateSections.push({
          name: "techniques", priority: 5,
          header: "**Learned techniques:**", rawEntries,
          content: renderEntrySection("**Learned techniques:**", rawEntries, TRUNCATE_LEN),
        });
      }
    }

    // 6. Key entity profiles section — REMOVED (2026-04-18). Surfaced
    // generic high-volume entities (Claude/React/GitHub) that were never
    // observably consulted during sessions. Kept the entity graph intact for
    // dashboard usage; just stopped paying its session-orient context cost.

    // 7. Pending contradictions count (priority 6)
    try {
      const contradictionCount = db
        .prepare("SELECT COUNT(*) as cnt FROM contradictions WHERE status = 'pending'")
        .get();
      if (contradictionCount && contradictionCount.cnt > 0) {
        candidateSections.push({
          name: "contradictions",
          priority: 7,
          content: `**Pending contradictions:** ${contradictionCount.cnt} (use \`memory_contradictions\` to review)`,
        });
      }
    } catch {}

    // 8. Known facts (priority 7)
    try {
      // Reuse already-computed contextKeywords (was double-computing without
      // the db-derived recent-tag pool, which made facts queries less aligned
      // with the same relevance signals decisions/threads use).
      const topKeywords = [...contextKeywords.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k);
      const seenFacts = new Set();
      const factResults = [];
      for (const kw of topKeywords) {
        if (factResults.length >= 3) break;
        const pattern = `%${kw}%`;
        const rows = db
          .prepare(
            `SELECT f.subject, f.predicate, f.object, f.confidence
             FROM facts f
             JOIN memories m ON f.memory_id = m.id AND m.is_active = 1
             WHERE f.subject LIKE ? OR f.object LIKE ?
             ORDER BY f.confidence DESC
             LIMIT 8`
          )
          .all(pattern, pattern);
        for (const row of rows) {
          const key = `${row.subject}|${row.predicate}|${row.object}`;
          if (!seenFacts.has(key) && factResults.length < 3) {
            seenFacts.add(key);
            factResults.push(row);
          }
        }
      }
      if (factResults.length > 0) {
        const lines = factResults.map(
          (f) => `- ${f.subject} ${f.predicate} ${f.object} (${Math.round(f.confidence * 100)}%)`
        );
        candidateSections.push({ name: "facts", priority: 8, content: `**Known facts:**\n${lines.join("\n")}` });
      }
    } catch {}

    // 9. Self-model functional directives (priority 9)
    const selfModel = db
      .prepare(
        `SELECT m.content
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = 'self-model' AND m.is_active = 1
         ORDER BY m.created_at DESC
         LIMIT 1`
      )
      .all();

    if (selfModel.length > 0) {
      const content = selfModel[0].content;
      const match = content.match(
        /## Functional Directives\n([\s\S]*?)(?=\n## |\s*$)/
      );
      if (match) {
        candidateSections.push({
          name: "self-model",
          priority: 10,
          content: `**Functional directives (from self-model):**\n${match[1].trim()}`,
        });
      }
    }
  } catch (err) {
    process.stderr.write("session-orient: " + (err instanceof Error ? err.message : String(err)) + "\n");
  }

  // Record access for surfaced memories (non-critical — failures don't affect output)
  try {
    if (surfacedIds.size > 0) {
      const ids = [...surfacedIds];
      const placeholders = ids.map(() => "?").join(",");
      db.exec("BEGIN");
      try {
        db.prepare(
          `UPDATE memories
           SET access_count = access_count + 1,
               last_accessed_at = datetime('now')
           WHERE id IN (${placeholders})`
        ).run(...ids);
        db.prepare(
          `UPDATE memories
           SET importance = MIN(importance + 0.01, 0.95)
           WHERE id IN (${placeholders}) AND importance < 0.9`
        ).run(...ids);
        const insertAccess = db.prepare(
          "INSERT INTO access_log (memory_id, query, accessed_at) VALUES (?, 'session-orient', datetime('now'))"
        );
        for (const id of ids) {
          insertAccess.run(id);
        }
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch {}
      }
    }
  } catch {}

  try {
    db.close();
  } catch {}

  // 10. Auto-detect skills from project tech stack (priority 8)
  try {
    const skillIndexPath = path.join(os.homedir(), ".claude", "skills", "skill-index.json");
    if (fs.existsSync(skillIndexPath)) {
      const skillIndex = JSON.parse(fs.readFileSync(skillIndexPath, "utf-8"));
      const matchedSkills = new Set();

      // Check package.json dependencies
      const pkgPath = path.join(cwd, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          for (const dep of Object.keys(allDeps)) {
            const skills = skillIndex.signals?.[dep];
            if (skills) {
              for (const s of skills) matchedSkills.add(s);
            }
          }
        } catch {}
      }

      // Check file signals
      if (skillIndex.fileSignals) {
        for (const [pattern, skills] of Object.entries(skillIndex.fileSignals)) {
          const extensions = ["", ".js", ".ts", ".mjs", ".cjs", ".json", ".yml", ".yaml"];
          const found = extensions.some((ext) =>
            fs.existsSync(path.join(cwd, pattern + ext))
          );
          if (found) {
            for (const s of skills) matchedSkills.add(s);
          }
        }
      }

      // Cap at 8 skills
      const skillNames = [...matchedSkills].slice(0, 8);

      if (skillNames.length > 0 && skillIndex.condensed) {
        const lines = [];
        for (const name of skillNames) {
          const rules = skillIndex.condensed[name];
          if (!rules || rules.length === 0) continue;
          lines.push(`### ${name}`);
          for (const rule of rules) {
            lines.push(`- ${rule}`);
          }
        }
        if (lines.length > 0) {
          candidateSections.push({
            name: "skills",
            priority: 9,
            content: `**Active skills (${skillNames.length}):**\n${lines.join("\n")}`,
          });
        }
      }
    }
  } catch {}

  if (candidateSections.length === 0) return;

  // Fill greedily by priority order until token budget is reached
  candidateSections.sort((a, b) => a.priority - b.priority);
  const selectedSections = [];
  const selectedIndices = [];
  let usedTokens = 0;

  for (let i = 0; i < candidateSections.length; i++) {
    const section = candidateSections[i];
    const sectionTokens = estimateTokens(section.content);
    if (selectedSections.length > 0 && usedTokens + sectionTokens > TOKEN_BUDGET) {
      continue; // Skip sections that would exceed budget, but keep trying smaller ones
    }
    selectedSections.push(section.content);
    selectedIndices.push(i);
    usedTokens += sectionTokens;
  }

  if (selectedSections.length === 0) return;

  // Second pass: expand sections with remaining budget
  const remainingTokens = TOKEN_BUDGET - usedTokens;
  if (remainingTokens > 100) {
    // Count how many selected sections have expandable raw entries
    const expandable = selectedIndices.filter((i) => candidateSections[i].rawEntries);
    if (expandable.length > 0) {
      const expandedLen = Math.min(
        300,
        TRUNCATE_LEN + Math.floor((remainingTokens * 4) / expandable.length)
      );
      if (expandedLen > TRUNCATE_LEN) {
        // Re-render expandable sections and recheck budget
        let newUsed = 0;
        for (let j = 0; j < selectedSections.length; j++) {
          const section = candidateSections[selectedIndices[j]];
          if (section.rawEntries) {
            const expanded = renderEntrySection(section.header, section.rawEntries, expandedLen);
            const expandedTokens = estimateTokens(expanded);
            if (newUsed + expandedTokens <= TOKEN_BUDGET) {
              selectedSections[j] = expanded;
              newUsed += expandedTokens;
            } else {
              newUsed += estimateTokens(selectedSections[j]);
            }
          } else {
            newUsed += estimateTokens(selectedSections[j]);
          }
        }
      }
    }
  }

  const context = selectedSections.join("\n\n");

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `<session-context source="exocortex">\n${context}\n</session-context>`,
      },
    })
  );
}

function truncate(text, maxLen = TRUNCATE_LEN) {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen - 3) + "...";
}

/** Render a section from raw entries with a given truncation length */
function renderEntrySection(header, rawEntries, truncLen) {
  const lines = rawEntries.map((e) => {
    const text = truncate(e.content, truncLen);
    return e.date ? `- ${text} (${e.date})` : `- ${text}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

main();
