/**
 * Action validator — detect suspicious patterns in agent outputs
 * that may indicate data exfiltration or manipulation.
 *
 * Defense layer 4: Catch exfiltration attempts in content being stored
 * or in agent-generated text after processing external content.
 */

export interface ValidationResult {
  safe: boolean;
  warnings: ValidationWarning[];
}

export interface ValidationWarning {
  type: string;
  detail: string;
  severity: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Sensitive data patterns
// ---------------------------------------------------------------------------

interface SensitivePattern {
  type: string;
  pattern: RegExp;
  severity: "low" | "medium" | "high";
  detail: string;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // API keys and tokens
  {
    type: "api_key",
    pattern: /(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9-]{20,}|xox[bpsa]-[a-zA-Z0-9-]{10,}|ch_live_[a-f0-9]{40,}|ch_test_[a-f0-9]{40,}|rk_live_[a-zA-Z0-9]{20,}|rk_test_[a-zA-Z0-9]{20,}|whsec_[a-zA-Z0-9]{20,})/g,
    severity: "high",
    detail: "Possible API key/token detected",
  },
  // AWS keys
  {
    type: "aws_key",
    pattern: /(?:AKIA[0-9A-Z]{16}|(?:aws_secret_access_key|aws_access_key_id)\s*[=:]\s*\S+)/gi,
    severity: "high",
    detail: "Possible AWS credential detected",
  },
  // Private keys
  {
    type: "private_key",
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    severity: "high",
    detail: "Private key detected",
  },
  // Environment variable references with real-looking values (skip quoted placeholders)
  {
    type: "env_var",
    pattern: /(?:^|\n)\s*(?:export\s+)?(?:DATABASE_URL|HELIUS_API_KEY|BRAVE_SEARCH_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*=\s*(?!['"]?(?:\.\.\.|xxx|your[_-]|placeholder|example|<))[^\s'"]{10,}/gi,
    severity: "high",
    detail: "Environment variable with value detected",
  },
  // Database connection strings — skip obvious templates/examples with placeholder credentials
  {
    type: "connection_string",
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/(?!user:password@|\.\.\.@|\*+@|<)[^@\s]{3,}@(?!localhost|127\.0\.0\.1|example|xxx)[^\s]+/gi,
    severity: "high",
    detail: "Database connection string detected",
  },
  // Wallet private keys (Solana/Ethereum)
  {
    type: "wallet_key",
    pattern: /(?:(?:0x)?[a-fA-F0-9]{64}(?:\b|$)|\b[1-9A-HJ-NP-Za-km-z]{87,88}\b)/g,
    severity: "high",
    detail: "Possible wallet private key detected",
  },
  // Windows file paths with user-specific data
  {
    type: "path_leak",
    pattern: /[A-Z]:\\Users\\[a-zA-Z]+\\(?:\.ssh|\.gnupg|\.env|credentials|secrets)/gi,
    severity: "medium",
    detail: "Sensitive file path detected",
  },
  // JWT tokens
  {
    type: "jwt",
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    severity: "medium",
    detail: "JWT token detected",
  },
];

// ---------------------------------------------------------------------------
// Exfiltration attempt patterns
// ---------------------------------------------------------------------------

const EXFILTRATION_PATTERNS: SensitivePattern[] = [
  // Fetch/curl to external URL with data
  {
    type: "exfil_fetch",
    pattern: /(?:fetch|curl|wget|httpx?\.(?:get|post))\s*\(?\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"]+['"`]/gi,
    severity: "medium",
    detail: "Outbound HTTP request to external URL",
  },
  // Encoded data being sent somewhere — only flag when combined with actual secret values
  {
    type: "exfil_encoded",
    pattern: /(?:btoa|Buffer\.from)\s*\([^)]*(?:process\.env\.|API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD)/gi,
    severity: "high",
    detail: "Encoding sensitive data for transmission",
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate content for sensitive data or exfiltration patterns.
 * Call on content before storing to memory, or on agent outputs
 * after processing external content.
 */
export function validateContent(content: string): ValidationResult {
  const warnings: ValidationWarning[] = [];

  for (const sp of SENSITIVE_PATTERNS) {
    const matches = content.matchAll(sp.pattern);
    for (const match of matches) {
      // Skip short matches that are likely false positives
      if (match[0].length < 10) continue;
      warnings.push({
        type: sp.type,
        detail: `${sp.detail}: ${match[0].slice(0, 40)}...`,
        severity: sp.severity,
      });
    }
  }

  for (const sp of EXFILTRATION_PATTERNS) {
    const matches = content.matchAll(sp.pattern);
    for (const match of matches) {
      warnings.push({
        type: sp.type,
        detail: `${sp.detail}: ${match[0].slice(0, 60)}...`,
        severity: sp.severity,
      });
    }
  }

  const hasHigh = warnings.some((w) => w.severity === "high");

  return {
    safe: !hasHigh,
    warnings,
  };
}

/**
 * Redact sensitive data from content.
 * Use when content must be stored but contains secrets.
 */
export function redactSensitiveData(content: string): string {
  let redacted = content;
  for (const sp of SENSITIVE_PATTERNS) {
    if (sp.severity === "high") {
      redacted = redacted.replace(sp.pattern, `[REDACTED:${sp.type}]`);
    }
  }
  return redacted;
}
