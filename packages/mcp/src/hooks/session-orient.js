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
 */

import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.join(os.homedir(), ".exocortex", "exocortex.db");

function buildContextKeywords(cwd) {
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
  } catch {
    return;
  }

  const sections = [];
  const surfacedIds = new Set();

  try {
    // 1. Recent project-related memories (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const recentMemories = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.importance, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = ? AND m.is_active = 1 AND m.created_at >= ?
         ORDER BY m.created_at DESC
         LIMIT 5`
      )
      .all(projectName, sevenDaysAgo);

    if (recentMemories.length > 0) {
      for (const m of recentMemories) surfacedIds.add(m.id);
      const lines = recentMemories.map(
        (m) => `- ${truncate(m.content, 150)} (${m.created_at.split("T")[0]})`
      );
      sections.push(`**Recent (${projectName}):**\n${lines.join("\n")}`);
    }

    // 2. Active goals
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
        const parts = [`- ${g.title}`];
        if (g.priority !== "medium") parts[0] += ` [${g.priority}]`;
        if (g.deadline) parts[0] += ` (due: ${g.deadline})`;
        // Show milestone progress if available
        try {
          const meta = JSON.parse(g.metadata || "{}");
          const milestones = meta.milestones;
          if (Array.isArray(milestones) && milestones.length > 0) {
            const done = milestones.filter((m) => m.status === "completed").length;
            parts[0] += ` — ${done}/${milestones.length} milestones`;
          }
        } catch {}
        return parts[0];
      });
      sections.push(`**Active goals:**\n${lines.join("\n")}`);
    }

    // 3. Recent decisions (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const decisionCandidates = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = 'decision' AND m.is_active = 1 AND m.created_at >= ?
         ORDER BY m.created_at DESC
         LIMIT 10`
      )
      .all(thirtyDaysAgo);

    if (decisionCandidates.length > 0) {
      // buildContextKeywords may not exist yet at this point — build early keywords from project name
      const earlyKeywords = buildContextKeywords(cwd);
      const scored = decisionCandidates.map((m) => ({
        ...m,
        relevance: scoreRelevance(m.content, earlyKeywords),
      }));
      scored.sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        return b.created_at > a.created_at ? 1 : -1;
      });
      const top = scored.filter((m) => m.relevance > 0).slice(0, 3);
      if (top.length > 0) {
        for (const m of top) surfacedIds.add(m.id);
        const lines = top.map(
          (m) => `- ${truncate(m.content, 150)} (${m.created_at.split("T")[0]})`
        );
        sections.push(`**Recent decisions:**\n${lines.join("\n")}`);
      }
    }

    // 4. Technique memories — reusable procedures learned by AI agents
    //    Over-fetch and rerank by project relevance
    const contextKeywords = buildContextKeywords(cwd);
    const techniqueCandidates = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.importance, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = 'technique' AND m.is_active = 1
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT 15`
      )
      .all();

    if (techniqueCandidates.length > 0) {
      const scored = techniqueCandidates.map((m) => ({
        ...m,
        relevance: scoreRelevance(m.content, contextKeywords),
      }));
      scored.sort((a, b) => {
        const aRelevant = a.relevance > 0 ? 1 : 0;
        const bRelevant = b.relevance > 0 ? 1 : 0;
        if (bRelevant !== aRelevant) return bRelevant - aRelevant;
        return b.importance - a.importance;
      });
      const top = scored.filter((m) => m.relevance > 0).slice(0, 5);
      if (top.length > 0) {
        for (const m of top) surfacedIds.add(m.id);
        const lines = top.map((m) => `- ${truncate(m.content, 150)}`);
        sections.push(`**Learned techniques:**\n${lines.join("\n")}`);
      }
    }

    // 5. Open threads — recent plan/todo/in-progress memories not yet resolved
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
         ORDER BY m.created_at DESC
         LIMIT 8`
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
      const top = scored.filter((m) => m.relevance > 0).slice(0, 3);
      if (top.length > 0) {
        for (const m of top) surfacedIds.add(m.id);
        const lines = top.map(
          (m) => `- ${truncate(m.content, 150)} (${m.created_at.split("T")[0]})`
        );
        sections.push(`**Open threads:**\n${lines.join("\n")}`);
      }
    }
    // 6. Key entity profiles — precomputed summaries of important entities
    try {
      const entityRows = db
        .prepare(
          `SELECT e.id, e.name, e.metadata, COUNT(*) as link_count
           FROM entities e
           JOIN memory_entities me ON e.id = me.entity_id
           JOIN memories m ON me.memory_id = m.id AND m.is_active = 1
           GROUP BY e.id
           HAVING COUNT(*) >= 3
           ORDER BY link_count DESC
           LIMIT 8`
        )
        .all();

      if (entityRows.length > 0) {
        // Score by project relevance
        const scored = entityRows.map((row) => {
          let meta = {};
          try { meta = JSON.parse(row.metadata || "{}"); } catch {}
          const profile = meta.profile;
          if (!profile) return null;
          const relevance = scoreRelevance(`${row.name} ${profile}`, contextKeywords);
          return { name: row.name, profile, relevance };
        }).filter(Boolean);

        scored.sort((a, b) => b.relevance - a.relevance);
        const top = scored.filter((e) => e.relevance > 0).slice(0, 5);
        if (top.length > 0) {
          const lines = top.map((e) => `- **${e.name}**: ${e.profile}`);
          sections.push(`**Key entities:**\n${lines.join("\n")}`);
        }
      }
    } catch {}

    // 7. Self-model functional directives
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
        sections.push(
          `**Functional directives (from self-model):**\n${match[1].trim()}`
        );
      }
    }

    // 8. Pending contradictions count
    try {
      const contradictionCount = db
        .prepare("SELECT COUNT(*) as cnt FROM contradictions WHERE status = 'pending'")
        .get();
      if (contradictionCount && contradictionCount.cnt > 0) {
        sections.push(`**Pending contradictions:** ${contradictionCount.cnt} (use \`memory_contradictions\` to review)`);
      }
    } catch {}

    // 9. Known facts — structured SPO triples from Phase 2
    try {
      const topKeywords = [...buildContextKeywords(cwd).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k);
      const seenFacts = new Set();
      const factResults = [];
      for (const kw of topKeywords) {
        if (factResults.length >= 5) break;
        const pattern = `%${kw}%`;
        const rows = db
          .prepare(
            `SELECT f.subject, f.predicate, f.object, f.confidence
             FROM facts f
             JOIN memories m ON f.memory_id = m.id AND m.is_active = 1
             WHERE f.subject LIKE ? OR f.object LIKE ?
             ORDER BY f.confidence DESC
             LIMIT 10`
          )
          .all(pattern, pattern);
        for (const row of rows) {
          const key = `${row.subject}|${row.predicate}|${row.object}`;
          if (!seenFacts.has(key) && factResults.length < 5) {
            seenFacts.add(key);
            factResults.push(row);
          }
        }
      }
      if (factResults.length > 0) {
        const lines = factResults.map(
          (f) => `- ${f.subject} ${f.predicate} ${f.object} (${Math.round(f.confidence * 100)}%)`
        );
        sections.push(`**Known facts:**\n${lines.join("\n")}`);
      }
    } catch {}
  } catch {
    // Query failures are non-critical — just skip
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

  // 10. Auto-detect skills from project tech stack
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
          sections.push(
            `**Active skills (${skillNames.length}):**\n${lines.join("\n")}`
          );
        }
      }
    }
  } catch {}

  if (sections.length === 0) return;

  const context = sections.join("\n\n");

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `<session-context source="exocortex">\n${context}\n</session-context>`,
      },
    })
  );
}

function truncate(text, maxLen) {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen - 3) + "...";
}

main();
