export { sanitizeContent, hasHighSeverityThreats } from "./sanitize.js";
export type { SanitizeResult, ThreatDetection, ThreatType } from "./sanitize.js";

export { checkUrl, filterUrls } from "./url-reputation.js";
export type { UrlCheckResult } from "./url-reputation.js";

export {
  wrapExternalContent,
  stripBoundaryMarkers,
  buildProvenanceMetadata,
  classifyTrust,
} from "./boundary.js";
export type { BoundaryOptions, TrustLevel } from "./boundary.js";

export { validateContent, redactSensitiveData } from "./action-validator.js";
export type { ValidationResult, ValidationWarning } from "./action-validator.js";

export { detectInfluence } from "./influence-detector.js";
export type { InfluenceScore, InfluenceSignal } from "./influence-detector.js";

export { buildProvenance, extractProvenance, mergeProvenance, aggregateTrust } from "./provenance.js";
export type { ProvenanceRecord } from "./provenance.js";

export { runBehavioralAudit } from "./behavioral-monitor.js";
export type { AnomalyReport, Anomaly, AnomalyType, MonitorStats } from "./behavioral-monitor.js";
