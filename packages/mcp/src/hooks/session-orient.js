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
const TOKEN_BUDGET = 1500;
const TRUNCATE_LEN = 120;

// Quality filter clause — NULL check ensures pre-migration memories aren't excluded
const QUALITY_FILTER = "AND (m.quality_score IS NULL OR m.quality_score >= 0.25)";

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

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

  // candidateSections: { name, priority, content }
  // Priority order: soul/identity → goals → stalled-goals → decisions → threads → recent → techniques → entities → contradictions → facts → skills → self-model
  const candidateSections = [];
  const surfacedIds = new Set();

  try {
    const contextKeywords = buildContextKeywords(cwd);

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
             ORDER BY m.importance DESC, m.created_at DESC
             LIMIT 1`
          )
          .get(tag);
        if (row) soulIdentity.push(row);
      }

      if (soulIdentity.length > 0) {
        for (const m of soulIdentity) surfacedIds.add(m.id);
        // Extract bullet lines — skip headers, blank lines, and sub-headers
        const summaryLines = [];
        for (const m of soulIdentity) {
          const lines = m.content.split("\n").filter((l) => {
            const t = l.trim();
            return t && !t.startsWith("#") && t.length > 10;
          });
          summaryLines.push(...lines.slice(0, 5));
        }
        if (summaryLines.length > 0) {
          candidateSections.push({
            name: "soul-identity",
            priority: 0,
            content: `**Soul & Identity:**\n${summaryLines.map((l) => l.startsWith("-") ? l : `- ${l}`).join("\n")}`,
          });
        }
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

    // 6. Key entity profiles (priority 5)
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
           LIMIT 6`
        )
        .all();

      if (entityRows.length > 0) {
        const scored = entityRows.map((row) => {
          let meta = {};
          try { meta = JSON.parse(row.metadata || "{}"); } catch {}
          const profile = meta.profile;
          if (!profile) return null;
          const relevance = scoreRelevance(`${row.name} ${profile}`, contextKeywords);
          return { name: row.name, profile, relevance };
        }).filter(Boolean);

        scored.sort((a, b) => b.relevance - a.relevance);
        const top = scored.filter((e) => e.relevance > 0).slice(0, 3);
        if (top.length > 0) {
          const lines = top.map((e) => `- **${e.name}**: ${e.profile}`);
          candidateSections.push({ name: "entities", priority: 6, content: `**Key entities:**\n${lines.join("\n")}` });
        }
      }
    } catch {}

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
      const topKeywords = [...buildContextKeywords(cwd).entries()]
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
