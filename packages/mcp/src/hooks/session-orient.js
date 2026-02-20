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
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.join(os.homedir(), ".exocortex", "exocortex.db");

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
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1000");
  } catch {
    return;
  }

  const sections = [];

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

    const decisions = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = 'decision' AND m.is_active = 1 AND m.created_at >= ?
         ORDER BY m.created_at DESC
         LIMIT 3`
      )
      .all(thirtyDaysAgo);

    if (decisions.length > 0) {
      const lines = decisions.map(
        (m) => `- ${truncate(m.content, 150)} (${m.created_at.split("T")[0]})`
      );
      sections.push(`**Recent decisions:**\n${lines.join("\n")}`);
    }

    // 4. Technique memories — reusable procedures learned by sentinel agents
    const techniques = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.importance, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag = 'technique' AND m.is_active = 1
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT 5`
      )
      .all();

    if (techniques.length > 0) {
      const lines = techniques.map(
        (m) => `- ${truncate(m.content, 150)}`
      );
      sections.push(`**Learned techniques:**\n${lines.join("\n")}`);
    }

    // 5. Open threads — recent plan/todo/in-progress memories not yet resolved
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const openThreads = db
      .prepare(
        `SELECT DISTINCT m.id, m.content, m.created_at
         FROM memories m
         INNER JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE mt.tag IN ('plan', 'todo', 'next-steps', 'in-progress')
           AND m.is_active = 1
           AND m.superseded_by IS NULL
           AND m.created_at >= ?
         ORDER BY m.created_at DESC
         LIMIT 3`
      )
      .all(fourteenDaysAgo);

    if (openThreads.length > 0) {
      const lines = openThreads.map(
        (m) => `- ${truncate(m.content, 150)} (${m.created_at.split("T")[0]})`
      );
      sections.push(`**Open threads:**\n${lines.join("\n")}`);
    }
  } catch {
    // Query failures are non-critical — just skip
  } finally {
    try {
      db.close();
    } catch {}
  }

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
