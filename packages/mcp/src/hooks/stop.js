#!/usr/bin/env node

/**
 * Claude Code Stop hook — reminds Claude to store an Exocortex session summary
 * for substantial sessions before exiting.
 *
 * Reads hook input from stdin. If the session had meaningful tool usage
 * and no summary was already stored, blocks exit with a reminder.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const approve = () => console.log(JSON.stringify({ decision: "approve" }));

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    return approve();
  }

  const transcriptPath = hookData.transcript_path;
  if (!transcriptPath) return approve();

  // Check transcript file size as proxy for session substance
  let fileSize = 0;
  try {
    const stats = fs.statSync(transcriptPath);
    fileSize = stats.size;
  } catch {
    return approve();
  }

  // Threshold: ~50KB suggests a substantial session (not just CLAUDE.md loading)
  const THRESHOLD_BYTES = 50_000;
  if (fileSize < THRESHOLD_BYTES) return approve();

  // Auto-approve on second block: if we already reminded once this session, let it go
  const lockFile = path.join(os.tmpdir(), `exo-stop-${path.basename(transcriptPath)}.lock`);
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); } catch {}
    return approve();
  }

  // Scan transcript for a memory_store or memory_update call with content_type "summary"
  // If one exists, no need to remind — approve exit
  try {
    const hasSummary = await scanForSummary(transcriptPath);
    if (hasSummary) return approve();
  } catch {
    return approve();
  }

  // First block — write lock file so next attempt auto-approves
  try { fs.writeFileSync(lockFile, Date.now().toString()); } catch {}

  console.log(
    JSON.stringify({
      decision: "block",
      reason:
        "This was a substantial session. Before exiting, please store an Exocortex session summary using memory_store with tags for the project/topic and content_type 'summary'. If you've already saved one, just exit again.",
    })
  );
}

/**
 * Stream-scan the JSONL transcript for a memory_store or memory_update
 * tool call with content_type "summary". Uses string pre-filter for speed,
 * then JSON-parses only matching lines to verify it's a real tool call.
 */
function scanForSummary(filePath) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let found = false;

    rl.on("line", (line) => {
      // Fast string pre-filter — skip lines that can't possibly match
      if (!line.includes("summary")) return;
      if (!line.includes("memory_store") && !line.includes("memory_update")) return;

      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") return;

        const content = entry.message?.content;
        if (!Array.isArray(content)) return;

        for (const block of content) {
          if (block.type !== "tool_use") continue;
          // memory_store with content_type summary
          if (
            block.name === "mcp__exocortex__memory_store" &&
            block.input?.content_type === "summary"
          ) {
            found = true;
            rl.close();
            return;
          }
          // memory_update that sets content_type to summary
          if (
            block.name === "mcp__exocortex__memory_update" &&
            block.input?.content_type === "summary"
          ) {
            found = true;
            rl.close();
            return;
          }
        }
      } catch {
        // Not valid JSON or unexpected shape — skip
      }
    });

    rl.on("close", () => resolve(found));
    rl.on("error", () => resolve(false));
  });
}

main();
