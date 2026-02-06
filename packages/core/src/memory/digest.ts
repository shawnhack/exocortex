import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface DigestAction {
  tool: string;
  summary: string;
  file_path?: string;
}

export type FactType = "decision" | "discovery" | "architecture" | "learning";

export interface ExtractedFact {
  type: FactType;
  text: string;
}

export interface DigestResult {
  project: string | null;
  actions: DigestAction[];
  facts: ExtractedFact[];
  summary: string;
  stats: { tools_used: number; files_changed: number; commands_run: number };
}

/** Tools to skip — read-only and internal tools */
const SKIP_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

function extractAction(block: ToolUseBlock): DigestAction | null {
  const name = block.name;
  const input = block.input ?? {};

  // Skip exocortex MCP calls
  if (name.startsWith("mcp__exocortex__")) return null;
  if (SKIP_TOOLS.has(name)) return null;

  switch (name) {
    case "Write":
      return {
        tool: "Write",
        summary: `Write ${input.file_path ?? "unknown"}`,
        file_path: input.file_path as string | undefined,
      };
    case "Edit":
      return {
        tool: "Edit",
        summary: `Edit ${input.file_path ?? "unknown"}`,
        file_path: input.file_path as string | undefined,
      };
    case "Bash": {
      const cmd = String(input.command ?? "").substring(0, 150);
      return { tool: "Bash", summary: `Bash: ${cmd}` };
    }
    case "WebFetch":
      return { tool: "WebFetch", summary: `Fetch: ${input.url ?? "unknown"}` };
    case "WebSearch":
      return {
        tool: "WebSearch",
        summary: `Search: ${input.query ?? "unknown"}`,
      };
    case "Skill":
      return { tool: "Skill", summary: `Skill: ${input.skill ?? "unknown"}` };
    case "NotebookEdit":
      return {
        tool: "NotebookEdit",
        summary: `NotebookEdit ${input.notebook_path ?? "unknown"}`,
        file_path: input.notebook_path as string | undefined,
      };
    case "LSP":
      return {
        tool: "LSP",
        summary: `LSP ${input.operation ?? ""} ${input.filePath ?? ""}:${input.line ?? ""}`,
        file_path: input.filePath as string | undefined,
      };
    default:
      // Unknown tool — include it
      return { tool: name, summary: name };
  }
}

/** Deduplicate consecutive identical action summaries */
function dedup(actions: DigestAction[]): DigestAction[] {
  const result: DigestAction[] = [];
  for (const action of actions) {
    const prev = result[result.length - 1];
    if (prev && prev.summary === action.summary) continue;
    result.push(action);
  }
  return result;
}

/** Detect project name from the most common directory prefix across file paths */
function detectProject(actions: DigestAction[]): string | null {
  const paths = actions
    .map((a) => a.file_path)
    .filter((p): p is string => !!p);

  if (paths.length === 0) return null;

  // Normalize to forward slashes
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));

  // Find longest common prefix
  let prefix = normalized[0];
  for (let i = 1; i < normalized.length; i++) {
    while (!normalized[i].startsWith(prefix)) {
      const slash = prefix.lastIndexOf("/");
      if (slash <= 0) return null;
      prefix = prefix.substring(0, slash);
    }
  }

  // Extract last meaningful segment
  const segments = prefix.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  // Skip generic segments
  const skip = new Set(["src", "lib", "dist", "packages", "node_modules"]);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!skip.has(segments[i])) return segments[i];
  }
  return segments[segments.length - 1];
}

// --- Fact Extraction ---

interface FactPattern {
  re: RegExp;
  type: FactType;
}

const FACT_PATTERNS: FactPattern[] = [
  // Decisions
  { re: /\b(?:decided to|chose|going with|will use|switched to|opting for|went with)\b/i, type: "decision" },
  // Discoveries
  { re: /\b(?:found that|discovered|turns out|the issue was|root cause|the problem was|the fix was)\b/i, type: "discovery" },
  // Architecture
  { re: /\b(?:architecture:|design:|approach:|pattern:|the approach is|the design is)\b/i, type: "architecture" },
  // Learnings
  { re: /\b(?:learned that|note to self|important:|remember that|key insight|takeaway)\b/i, type: "learning" },
];

/**
 * Extract discrete facts and decisions from assistant text blocks in a transcript.
 */
export function extractFacts(assistantTexts: string[]): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const text of assistantTexts) {
    // Split into sentences
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 15);

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];

      for (const pattern of FACT_PATTERNS) {
        if (pattern.re.test(sentence)) {
          // Get surrounding context (1 sentence before/after)
          const parts: string[] = [];
          if (i > 0) parts.push(sentences[i - 1]);
          parts.push(sentence);
          if (i < sentences.length - 1) parts.push(sentences[i + 1]);
          const factText = parts.join(" ").trim();

          // Simple dedup by checking overlap
          const normalized = factText.toLowerCase().replace(/\s+/g, " ");
          if (normalized.length > 300) continue; // Skip overly long matches
          if (seen.has(normalized)) continue;

          // Check overlap with existing facts
          let isDupe = false;
          for (const existing of seen) {
            if (overlapRatio(normalized, existing) > 0.7) {
              isDupe = true;
              break;
            }
          }
          if (isDupe) continue;

          seen.add(normalized);
          facts.push({ type: pattern.type, text: factText });
          break; // One fact type per sentence
        }
      }
    }
  }

  return facts;
}

/** Compute word overlap ratio between two strings */
function overlapRatio(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/**
 * Parse a Claude Code session transcript JSONL and extract a structured digest.
 */
export async function digestTranscript(
  transcriptPath: string,
): Promise<DigestResult> {
  const actions: DigestAction[] = [];
  const assistantTexts: string[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    let entry: {
      type: string;
      message?: { content?: unknown[] };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "assistant") continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
      if (block.type === "tool_use") {
        const action = extractAction(block as ToolUseBlock);
        if (action) actions.push(action);
      } else if (block.type === "text" && block.text) {
        assistantTexts.push(block.text);
      }
    }
  }

  const deduped = dedup(actions);
  const project = detectProject(deduped);
  const facts = extractFacts(assistantTexts);

  const files = new Set(deduped.filter((a) => a.file_path).map((a) => a.file_path));
  const commands = deduped.filter((a) => a.tool === "Bash").length;
  const tools = new Set(deduped.map((a) => a.tool));

  const date = new Date().toISOString().split("T")[0];
  const lines = deduped.map((a) => `- ${a.summary}`);
  const statsLine = `Files changed: ${files.size} | Commands: ${commands} | Tools used: ${tools.size}`;

  const summaryParts = [
    `Session ${date}${project ? ` (project: ${project})` : ""}`,
    ...lines,
    "",
    statsLine,
  ];

  if (facts.length > 0) {
    summaryParts.push("", "Key takeaways:");
    for (const fact of facts.slice(0, 10)) {
      summaryParts.push(`- [${fact.type}] ${fact.text}`);
    }
  }

  const summary = summaryParts.join("\n");

  return {
    project,
    actions: deduped,
    facts,
    summary,
    stats: {
      tools_used: tools.size,
      files_changed: files.size,
      commands_run: commands,
    },
  };
}
