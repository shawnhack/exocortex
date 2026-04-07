/**
 * URL reputation checking — block known-bad domains and suspicious URL patterns
 * before fetching content.
 *
 * Defense layer 2: Prevents agents from visiting known malicious sites.
 */

export interface UrlCheckResult {
  url: string;
  allowed: boolean;
  reason?: string;
  riskLevel: "safe" | "suspicious" | "blocked";
}

// ---------------------------------------------------------------------------
// Blocklists
// ---------------------------------------------------------------------------

/** Known malicious or deceptive domains */
const BLOCKED_DOMAINS = new Set([
  // Phishing/scam aggregators
  "bit.ly.malware.example",
  // Prompt injection testing sites
  "promptinjection.com",
  "injectprompt.com",
  // Known crypto scam domains (patterns)
]);

/** Suspicious TLD patterns — not blocked, but flagged */
const SUSPICIOUS_TLDS = new Set([
  ".tk", ".ml", ".ga", ".cf", ".gq",  // Free TLDs heavily used for spam
  ".zip", ".mov",                       // Confusing file-extension TLDs
  ".top", ".xyz", ".icu", ".buzz",     // High spam volume TLDs
]);

/** Domain patterns to block (regex) */
const BLOCKED_DOMAIN_PATTERNS: RegExp[] = [
  // IP-address-as-domain (often phishing)
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  // Punycode/IDN homograph attacks
  /^xn--.*\.xn--/,
  // Extremely long subdomains (phishing tactic)
  /^[^.]{50,}\./,
  // Known typosquat patterns — only catch mutations, not real domains
  /(?:g[o0]{2}gle\.(?!com)|g0ogle\.|go0gle\.|githuh\.|gith[uo]b\.(?!com)|gihtub\.|anthrop[il1]c\.(?!com)|anthroplc\.|openai\d\.|claude-?ai\.(?!com))/i,
];

/** Suspicious URL path patterns */
const SUSPICIOUS_PATH_PATTERNS: RegExp[] = [
  // Data URI schemes
  /^data:/i,
  // JavaScript URIs
  /^javascript:/i,
  // File URIs (local file access)
  /^file:/i,
  // Extremely long URLs (often obfuscation)
  /.{2000,}/,
  // Multiple redirects encoded in URL
  /(?:redirect|redir|goto|url|link|next)=https?%3A/gi,
  // Credential harvesting paths
  /(?:login|signin|auth|password|credential|\.env|\.git|wp-admin)/i,
];

// ---------------------------------------------------------------------------
// URL checking
// ---------------------------------------------------------------------------

/**
 * Check a URL against blocklists and heuristics.
 * Call before fetching any external URL.
 */
export function checkUrl(rawUrl: string): UrlCheckResult {
  // Basic validation
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, allowed: false, reason: "Invalid URL", riskLevel: "blocked" };
  }

  // Block non-HTTP(S) schemes
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      url: rawUrl,
      allowed: false,
      reason: `Blocked protocol: ${parsed.protocol}`,
      riskLevel: "blocked",
    };
  }

  // Block localhost/internal IPs (SSRF prevention)
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.") ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return {
      url: rawUrl,
      allowed: false,
      reason: "Blocked: internal/localhost URL (SSRF prevention)",
      riskLevel: "blocked",
    };
  }

  // Check explicit blocklist
  if (BLOCKED_DOMAINS.has(hostname)) {
    return {
      url: rawUrl,
      allowed: false,
      reason: `Blocked domain: ${hostname}`,
      riskLevel: "blocked",
    };
  }

  // Check domain patterns
  for (const pattern of BLOCKED_DOMAIN_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        url: rawUrl,
        allowed: false,
        reason: `Blocked domain pattern: ${pattern.source}`,
        riskLevel: "blocked",
      };
    }
  }

  // Check full URL against path patterns
  for (const pattern of SUSPICIOUS_PATH_PATTERNS) {
    if (pattern.test(rawUrl)) {
      pattern.lastIndex = 0;
      return {
        url: rawUrl,
        allowed: false,
        reason: `Blocked URL pattern: ${pattern.source}`,
        riskLevel: "blocked",
      };
    }
  }

  // Check suspicious TLDs — allow but flag
  const tld = "." + hostname.split(".").pop();
  if (SUSPICIOUS_TLDS.has(tld)) {
    return {
      url: rawUrl,
      allowed: true,
      reason: `Suspicious TLD: ${tld}`,
      riskLevel: "suspicious",
    };
  }

  return { url: rawUrl, allowed: true, riskLevel: "safe" };
}

/**
 * Check multiple URLs, returning only the safe/allowed ones.
 */
export function filterUrls(urls: string[]): { allowed: UrlCheckResult[]; blocked: UrlCheckResult[] } {
  const allowed: UrlCheckResult[] = [];
  const blocked: UrlCheckResult[] = [];

  for (const url of urls) {
    const result = checkUrl(url);
    if (result.allowed) {
      allowed.push(result);
    } else {
      blocked.push(result);
    }
  }

  return { allowed, blocked };
}
