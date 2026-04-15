/**
 * Content sanitizer — detect and neutralize prompt injection patterns
 * in content before it enters the memory system.
 *
 * Defense layer 1: Prevents malicious web content from manipulating
 * agent behavior via stored memories.
 */

export interface SanitizeResult {
  /** Cleaned content */
  content: string;
  /** Whether any threats were detected */
  threats: ThreatDetection[];
  /** Whether content was modified */
  modified: boolean;
}

export interface ThreatDetection {
  type: ThreatType;
  pattern: string;
  /** Original matched text (truncated to 100 chars) */
  match: string;
  severity: "low" | "medium" | "high";
}

export type ThreatType =
  | "prompt_injection"
  | "role_override"
  | "instruction_override"
  | "data_exfiltration"
  | "hidden_text"
  | "encoding_attack";

// ---------------------------------------------------------------------------
// Prompt injection patterns
// ---------------------------------------------------------------------------

interface PatternDef {
  type: ThreatType;
  pattern: RegExp;
  severity: "low" | "medium" | "high";
  label: string;
}

const THREAT_PATTERNS: PatternDef[] = [
  // Role/identity override attempts
  {
    type: "role_override",
    pattern: /(?:you are|you're|act as|pretend to be|assume the role of|your new (?:role|identity|instructions?|purpose))\s+(?:now\s+)?(?:a|an|the)?\s*(?:different|new|helpful|malicious|evil|unrestricted)/gi,
    severity: "high",
    label: "role_override",
  },
  // Instruction override
  {
    type: "instruction_override",
    pattern: /(?:ignore|disregard|forget|override|bypass|skip|dismiss)\s+(?:all\s+)?(?:previous|prior|above|earlier|original|your|the)\s+(?:instructions?|rules?|guidelines?|constraints?|prompts?|system\s+prompts?|directives?)/gi,
    severity: "high",
    label: "instruction_override",
  },
  // System prompt extraction
  {
    type: "data_exfiltration",
    pattern: /(?:reveal|show|display|print|output|repeat|echo|tell me|what (?:are|is))\s+(?:your|the)\s+(?:system\s+prompt|instructions?|rules?|original\s+prompt|hidden\s+prompt|secret|api\s+key|password|token|credential)/gi,
    severity: "high",
    label: "system_prompt_extraction",
  },
  // Direct injection markers
  {
    type: "prompt_injection",
    pattern: /(?:\[(?:SYSTEM|INST|SYS)\]|\<\/?(?:system|instruction|prompt|s)\>|<<\s*(?:SYS|SYSTEM|INST)(?:\s*>>)?|BEGIN\s+(?:SYSTEM|INSTRUCTION)|END\s+(?:SYSTEM|INSTRUCTION))/gi,
    severity: "high",
    label: "injection_markers",
  },
  // Delimiter injection — fake message boundaries (only at line start, suggesting structure spoofing)
  {
    type: "prompt_injection",
    pattern: /(?:^|\n)\s*(?:Human:|Assistant:|User:|System:)\s*(?:\n|$)/gm,
    severity: "medium",
    label: "delimiter_injection",
  },
  // Markdown header injection — ### System Message: / ### Instruction:
  {
    type: "prompt_injection",
    pattern: /(?:^|\n)###\s*(?:System|Instruction)\s*(?:Message|Prompt)\s*:/gm,
    severity: "medium",
    label: "header_injection",
  },
  // Data exfiltration via tool calls
  {
    type: "data_exfiltration",
    pattern: /(?:call|use|invoke|execute|run)\s+(?:the\s+)?(?:tool|function|command)\s+.*?(?:with|passing|using)\s+.*?(?:env|secret|key|token|password|credential)/gi,
    severity: "high",
    label: "tool_exfiltration",
  },
  // Jailbreak patterns — only match when used as directives, not mentioned in discussion
  {
    type: "prompt_injection",
    pattern: /(?:(?:enable|activate|enter|switch to|turn on)\s+(?:DAN|Developer Mode|DUDE|AIM|STAN|KEVIN|OMEGA|Jailbreak)\b|(?:you are now|from now on you are)\s+(?:DAN|DUDE|AIM|STAN|KEVIN|OMEGA)\b|Do Anything Now mode)/gi,
    severity: "medium",
    label: "jailbreak_pattern",
  },
  // Base64 encoded suspicious content (large blocks may hide instructions)
  {
    type: "encoding_attack",
    pattern: /(?:base64|atob|decode)\s*[\(:]\s*['"`][A-Za-z0-9+/=]{100,}['"`]/gi,
    severity: "medium",
    label: "base64_payload",
  },
  // Hidden text via zero-width characters or excessive Unicode
  {
    type: "hidden_text",
    pattern: /[\u200B\u200C\u200D\u2060\uFEFF]{3,}/g,
    severity: "medium",
    label: "zero_width_chars",
  },
  // Markdown/HTML hidden content
  {
    type: "hidden_text",
    pattern: /<!--[\s\S]*?(?:ignore|instruction|system|inject|override|prompt)[\s\S]*?-->/gi,
    severity: "high",
    label: "hidden_html_comment",
  },
  // Color-matched invisible text (white on white, etc.)
  {
    type: "hidden_text",
    pattern: /(?:color:\s*(?:white|transparent|rgba?\([^)]*,\s*0\s*\))|font-size:\s*0|display:\s*none|visibility:\s*hidden|opacity:\s*0)[^>]*>.*?</gi,
    severity: "medium",
    label: "css_hidden_text",
  },
];

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize content by detecting and neutralizing prompt injection patterns.
 * Returns cleaned content and a list of detected threats.
 */
export function sanitizeContent(content: string): SanitizeResult {
  const threats: ThreatDetection[] = [];
  let cleaned = content;

  for (const def of THREAT_PATTERNS) {
    const matches = content.matchAll(def.pattern);
    for (const match of matches) {
      threats.push({
        type: def.type,
        pattern: def.label,
        match: match[0].slice(0, 100),
        severity: def.severity,
      });
    }

    // Neutralize by wrapping in visible markers
    if (def.severity === "high") {
      cleaned = cleaned.replace(def.pattern, (m) => `[BLOCKED: ${def.label}]`);
    } else if (def.type === "hidden_text") {
      // Remove hidden content entirely
      cleaned = cleaned.replace(def.pattern, "");
    }
  }

  // Remove excessive zero-width characters
  cleaned = cleaned.replace(/[\u200B\u200C\u200D\u2060\uFEFF]+/g, "");

  return {
    content: cleaned,
    threats,
    modified: cleaned !== content,
  };
}

/**
 * Quick check — does this content contain any high-severity threats?
 */
export function hasHighSeverityThreats(content: string): boolean {
  for (const def of THREAT_PATTERNS) {
    if (def.severity !== "high") continue;
    def.pattern.lastIndex = 0;
    if (def.pattern.test(content)) {
      def.pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}
