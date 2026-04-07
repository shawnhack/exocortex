/**
 * Influence Detector — NLP-based scoring that detects behavioral manipulation
 * in natural language without needing an LLM call.
 *
 * Catches what regex-based sanitizers miss: natural-sounding text that subtly
 * tries to modify agent behavior ("always recommend X", "when you see Y, do Z").
 *
 * Runs inline on every memory_store — no external API calls, ~1ms per check.
 */

export interface InfluenceScore {
  /** Overall influence score 0-1 (0 = neutral data, 1 = pure behavioral directive) */
  score: number;
  /** Individual signal scores */
  signals: InfluenceSignal[];
  /** Human-readable verdict */
  verdict: "safe" | "low" | "moderate" | "high";
}

export interface InfluenceSignal {
  type: string;
  score: number;
  matches: string[];
}

// ---------------------------------------------------------------------------
// Signal detectors — each returns 0-1 score
// ---------------------------------------------------------------------------

/** Imperative mood density — "always do X", "never do Y", "you must" */
function imperativeDensity(content: string): InfluenceSignal {
  const patterns = [
    /\b(?:you (?:must|should|need to|have to|are required to))\b/gi,
    /\b(?:always|never|do not ever|make sure to always|ensure you always)\b/gi,
    /\b(?:from now on|going forward|henceforth|from this point)\b/gi,
    /\b(?:it is (?:critical|essential|vital|imperative|mandatory) (?:that you|to))\b/gi,
  ];

  const matches: string[] = [];
  let hitCount = 0;
  for (const p of patterns) {
    const m = content.matchAll(p);
    for (const match of m) {
      matches.push(match[0]);
      hitCount++;
    }
  }

  const words = content.split(/\s+/).length;
  const density = words > 0 ? hitCount / (words / 100) : 0; // hits per 100 words
  return {
    type: "imperative_density",
    score: Math.min(density / 5, 1), // 5+ hits per 100 words = max
    matches: matches.slice(0, 5),
  };
}

/** Behavioral modification — attempts to install persistent rules */
function behavioralModification(content: string): InfluenceSignal {
  const patterns = [
    /\b(?:when(?:ever)? you (?:see|encounter|find|receive|process|handle))\b.*?,?\s*(?:you (?:should|must|need to)|always|make sure)/gi,
    /\b(?:remember to (?:always|never)|don't forget to (?:always|never))\b/gi,
    /\b(?:treat .{1,40} as|consider .{1,40} as|interpret .{1,40} as)\b/gi,
    /\b(?:the (?:correct|right|proper|best) (?:way|approach|method) is to)\b/gi,
    /\b(?:update your (?:behavior|approach|rules|understanding))\b/gi,
    /\b(?:add this to your (?:knowledge|rules|guidelines|instructions))\b/gi,
    /\b(?:prioritize .{1,40} over|prefer .{1,40} over|favor .{1,40} over)\b/gi,
  ];

  const matches: string[] = [];
  for (const p of patterns) {
    const m = content.matchAll(p);
    for (const match of m) {
      matches.push(match[0].slice(0, 80));
    }
  }

  return {
    type: "behavioral_modification",
    score: Math.min(matches.length / 3, 1), // 3+ matches = max
    matches: matches.slice(0, 5),
  };
}

/** Authority claims — attempts to establish credibility for manipulation */
function authorityClaims(content: string): InfluenceSignal {
  const patterns = [
    /\b(?:as (?:an? )?(?:expert|authority|senior|lead|principal|staff))\b/gi,
    /\b(?:according to (?:official|internal|confidential|authoritative))\b/gi,
    /\b(?:this is (?:the )?(?:official|authoritative|canonical|correct) (?:guidance|policy|directive|instruction))\b/gi,
    /\b(?:I (?:am|was) (?:authorized|instructed|directed|told) (?:by|to))\b/gi,
    /\b(?:management|leadership|the team|security team) (?:has |)(?:decided|requires|mandates|directs)\b/gi,
  ];

  const matches: string[] = [];
  for (const p of patterns) {
    const m = content.matchAll(p);
    for (const match of m) {
      matches.push(match[0]);
    }
  }

  return {
    type: "authority_claims",
    score: Math.min(matches.length / 2, 1),
    matches: matches.slice(0, 5),
  };
}

/** Urgency and pressure — create artificial time pressure */
function urgencyPressure(content: string): InfluenceSignal {
  const patterns = [
    /\b(?:immediately|urgently|right now|as soon as possible|ASAP|without delay|time[- ]sensitive|time[- ]critical)\b/gi,
    /\b(?:do this (?:before|first|now)|stop (?:everything|what you're doing))\b/gi,
    /\b(?:this (?:is|requires) (?:an? )?(?:emergency|critical|urgent))\b/gi,
    /\b(?:failure to .{1,40} will (?:result|cause|lead))\b/gi,
  ];

  const matches: string[] = [];
  for (const p of patterns) {
    const m = content.matchAll(p);
    for (const match of m) {
      matches.push(match[0].slice(0, 60));
    }
  }

  return {
    type: "urgency_pressure",
    score: Math.min(matches.length / 3, 1),
    matches: matches.slice(0, 5),
  };
}

/** Recommendation steering — subtly biases toward specific tools/products/approaches */
function recommendationSteering(content: string): InfluenceSignal {
  const patterns = [
    /\b(?:the (?:only|best|recommended|preferred|superior|optimal) (?:solution|approach|tool|framework|library|platform) is)\b/gi,
    /\b(?:you should (?:always |)(?:recommend|suggest|use|prefer|choose))\b/gi,
    /\b(?:never (?:recommend|suggest|use|consider))\b .{1,40}/gi,
    /\b(?:is (?:deprecated|obsolete|dangerous|insecure|harmful)(?:\.|,| and| —))\b/gi,
  ];

  const matches: string[] = [];
  for (const p of patterns) {
    const m = content.matchAll(p);
    for (const match of m) {
      matches.push(match[0].slice(0, 60));
    }
  }

  return {
    type: "recommendation_steering",
    score: Math.min(matches.length / 2, 1),
    matches: matches.slice(0, 5),
  };
}

/** Addressing the AI directly — content that speaks TO the model */
function directAddress(content: string): InfluenceSignal {
  const sentences = content.split(/[.!?\n]+/).filter((s) => s.trim().length > 5);
  let directCount = 0;
  const matches: string[] = [];

  for (const s of sentences) {
    // Sentences starting with "You" or containing "your instructions/rules/behavior"
    if (/^\s*you\b/i.test(s) || /\byour (?:instructions?|rules?|behavior|guidelines?|knowledge|memory|responses?)\b/i.test(s)) {
      directCount++;
      matches.push(s.trim().slice(0, 60));
    }
  }

  const ratio = sentences.length > 0 ? directCount / sentences.length : 0;
  return {
    type: "direct_address",
    score: Math.min(ratio * 3, 1), // 33%+ sentences addressing AI = max
    matches: matches.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

const SIGNAL_WEIGHTS: Record<string, number> = {
  imperative_density: 0.15,
  behavioral_modification: 0.30,
  authority_claims: 0.15,
  urgency_pressure: 0.10,
  recommendation_steering: 0.15,
  direct_address: 0.15,
};

/**
 * Score content for behavioral influence/manipulation signals.
 * Returns a composite score 0-1 and individual signal breakdowns.
 */
export function detectInfluence(content: string): InfluenceScore {
  // Skip very short content
  if (content.length < 50) {
    return { score: 0, signals: [], verdict: "safe" };
  }

  const signals = [
    imperativeDensity(content),
    behavioralModification(content),
    authorityClaims(content),
    urgencyPressure(content),
    recommendationSteering(content),
    directAddress(content),
  ];

  // Weighted composite score
  let score = 0;
  for (const signal of signals) {
    const weight = SIGNAL_WEIGHTS[signal.type] ?? 0.1;
    score += signal.score * weight;
  }

  // Only include signals that actually fired
  const activeSignals = signals.filter((s) => s.score > 0);

  // Determine verdict
  let verdict: InfluenceScore["verdict"];
  if (score < 0.1) verdict = "safe";
  else if (score < 0.3) verdict = "low";
  else if (score < 0.6) verdict = "moderate";
  else verdict = "high";

  return { score: Math.round(score * 1000) / 1000, signals: activeSignals, verdict };
}
