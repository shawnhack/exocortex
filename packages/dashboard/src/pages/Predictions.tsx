import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Prediction } from "../api/client";
import { useToast } from "../components/Toast";
import { timeAgo } from "../utils/format";

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  open: { color: "var(--cyan)", bg: "var(--cyan-bg)" },
  resolved: { color: "var(--emerald)", bg: "var(--emerald-bg)" },
  voided: { color: "var(--text-muted)", bg: "var(--muted-bg-subtle)" },
};

const RESOLUTION_COLORS: Record<string, string> = {
  true: "var(--emerald)",
  false: "var(--red)",
  partial: "var(--amber)",
};

const DOMAIN_COLORS: Record<string, string> = {
  technical: "var(--cyan)",
  product: "var(--purple)",
  market: "var(--emerald)",
  personal: "var(--amber)",
  political: "var(--rose)",
  scientific: "var(--sky)",
  general: "var(--text-muted)",
};

function confidenceBar(confidence: number) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.8 ? "var(--emerald)" : confidence >= 0.5 ? "var(--amber)" : "var(--red)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 80 }}>
      <div style={{ flex: 1, height: 4, background: "var(--border-subtle)", borderRadius: 2, minWidth: 40 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
    </div>
  );
}

export function Predictions() {
  const queryClient = useQueryClient();
  const { toast, confirmToast } = useToast();
  const [statusFilter, setStatusFilter] = useState("all");
  const [domainFilter, setDomainFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Create form
  const [newClaim, setNewClaim] = useState("");
  const [newConfidence, setNewConfidence] = useState("0.7");
  const [newDomain, setNewDomain] = useState("general");
  const [newDeadline, setNewDeadline] = useState("");

  // Resolve form
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [resolveResolution, setResolveResolution] = useState("true");
  const [resolveNotes, setResolveNotes] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["predictions", statusFilter, domainFilter],
    queryFn: () => api.getPredictions({
      status: statusFilter,
      domain: domainFilter,
    }),
  });

  const { data: stats } = useQuery({
    queryKey: ["prediction-stats"],
    queryFn: () => api.getPredictionStats(),
  });

  const createMutation = useMutation({
    mutationFn: () => api.createPrediction({
      claim: newClaim,
      confidence: parseFloat(newConfidence),
      domain: newDomain,
      deadline: newDeadline || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["predictions"] });
      queryClient.invalidateQueries({ queryKey: ["prediction-stats"] });
      setShowCreate(false);
      setNewClaim("");
      setNewConfidence("0.7");
      setNewDomain("general");
      setNewDeadline("");
      toast("Prediction created", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const resolveMutation = useMutation({
    mutationFn: () => api.resolvePrediction(resolveId!, {
      resolution: resolveResolution,
      resolution_notes: resolveNotes || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["predictions"] });
      queryClient.invalidateQueries({ queryKey: ["prediction-stats"] });
      setResolveId(null);
      setResolveResolution("true");
      setResolveNotes("");
      toast("Prediction resolved", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const voidMutation = useMutation({
    mutationFn: (id: string) => api.voidPrediction(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["predictions"] });
      queryClient.invalidateQueries({ queryKey: ["prediction-stats"] });
      toast("Prediction voided", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePrediction(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["predictions"] });
      queryClient.invalidateQueries({ queryKey: ["prediction-stats"] });
      setExpandedId(null);
      toast("Prediction deleted", "success");
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const statuses = ["all", "open", "resolved", "voided"];
  const domains = ["all", "technical", "product", "market", "personal", "general"];

  if (isLoading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading predictions...</span>
      </div>
    );
  }

  const predictions = data?.predictions ?? [];

  return (
    <div style={{ animation: "slideUp 0.3s ease-out both" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary-alt)", marginBottom: 4 }}>Predictions</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Track forecasts and calibrate confidence</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            background: "var(--cyan-bg)",
            color: "var(--cyan)",
            border: "1px solid var(--cyan-border)",
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--cyan-bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--cyan-bg)"; }}
        >
          + New Prediction
        </button>
      </div>

      {/* Calibration stats */}
      {stats && stats.resolved_count > 0 && (
        <>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Brier Score</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: stats.brier_score <= 0.15 ? "var(--emerald)" : stats.brier_score <= 0.25 ? "var(--amber)" : "var(--red)", fontVariantNumeric: "tabular-nums" }}>
              {stats.brier_score.toFixed(3)}
            </div>
          </div>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Resolved</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary-alt)", fontVariantNumeric: "tabular-nums" }}>
              {stats.resolved_count}<span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400 }}> / {stats.total_predictions}</span>
            </div>
          </div>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Bias</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: stats.overconfidence_bias > 0.05 ? "var(--amber)" : "var(--emerald)", fontVariantNumeric: "tabular-nums" }}>
              {stats.overconfidence_bias > 0 ? "+" : ""}{(stats.overconfidence_bias * 100).toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Calibration curve + Brier trend charts */}
        {stats.calibration_curve.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            {/* Calibration curve */}
            <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Calibration Curve</div>
              <svg viewBox="0 0 200 200" style={{ width: "100%", maxHeight: 180 }}>
                {/* Grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                  <line key={v} x1={20} y1={180 - v * 160} x2={195} y2={180 - v * 160} stroke="var(--border-subtle)" strokeWidth="0.5" />
                ))}
                {/* Perfect calibration diagonal */}
                <line x1={20} y1={180} x2={195} y2={20} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4,3" opacity={0.4} />
                {/* Actual calibration points */}
                {stats.calibration_curve.filter((b) => b.count > 0).map((bucket, i) => {
                  const x = 20 + bucket.predicted_avg * 175;
                  const y = 180 - bucket.actual_freq * 160;
                  const r = Math.min(8, Math.max(3, Math.sqrt(bucket.count) * 2));
                  return (
                    <g key={i}>
                      <circle cx={x} cy={y} r={r} fill="var(--cyan)" opacity={0.8} />
                      <title>{`Predicted: ${(bucket.predicted_avg * 100).toFixed(0)}% | Actual: ${(bucket.actual_freq * 100).toFixed(0)}% | n=${bucket.count}`}</title>
                    </g>
                  );
                })}
                {/* Calibration line connecting points */}
                {(() => {
                  const pts = stats.calibration_curve
                    .filter((b) => b.count > 0)
                    .map((b) => `${20 + b.predicted_avg * 175},${180 - b.actual_freq * 160}`);
                  return pts.length > 1 ? (
                    <polyline points={pts.join(" ")} fill="none" stroke="var(--cyan)" strokeWidth="1.5" opacity={0.6} />
                  ) : null;
                })()}
                {/* Axis labels */}
                <text x={107} y={198} textAnchor="middle" fill="var(--text-muted)" fontSize="8">Predicted</text>
                <text x={5} y={100} textAnchor="middle" fill="var(--text-muted)" fontSize="8" transform="rotate(-90, 5, 100)">Actual</text>
              </svg>
            </div>

            {/* Monthly Brier trend */}
            <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Brier Score Trend</div>
              {stats.trend.length > 1 ? (
                <svg viewBox="0 0 200 200" style={{ width: "100%", maxHeight: 180 }}>
                  {/* Grid lines */}
                  {[0, 0.1, 0.2, 0.3, 0.4, 0.5].map((v) => (
                    <g key={v}>
                      <line x1={30} y1={180 - v * 320} x2={195} y2={180 - v * 320} stroke="var(--border-subtle)" strokeWidth="0.5" />
                      <text x={27} y={183 - v * 320} textAnchor="end" fill="var(--text-muted)" fontSize="7">{v.toFixed(1)}</text>
                    </g>
                  ))}
                  {/* Trend line */}
                  {(() => {
                    const maxBrier = Math.max(0.5, ...stats.trend.map((t) => t.brier_score));
                    const pts = stats.trend.map((t, i) => {
                      const x = 30 + (i / Math.max(1, stats.trend.length - 1)) * 165;
                      const y = 180 - (t.brier_score / maxBrier) * 160;
                      return `${x},${y}`;
                    });
                    return (
                      <>
                        <polyline points={pts.join(" ")} fill="none" stroke="var(--emerald)" strokeWidth="2" />
                        {stats.trend.map((t, i) => {
                          const x = 30 + (i / Math.max(1, stats.trend.length - 1)) * 165;
                          const y = 180 - (t.brier_score / maxBrier) * 160;
                          return (
                            <g key={i}>
                              <circle cx={x} cy={y} r={3} fill="var(--emerald)" />
                              <title>{`${t.month}: ${t.brier_score.toFixed(3)} (n=${t.count})`}</title>
                            </g>
                          );
                        })}
                      </>
                    );
                  })()}
                  {/* Month labels */}
                  {stats.trend.length <= 6 && stats.trend.map((t, i) => {
                    const x = 30 + (i / Math.max(1, stats.trend.length - 1)) * 165;
                    return (
                      <text key={i} x={x} y={195} textAnchor="middle" fill="var(--text-muted)" fontSize="7">
                        {t.month.slice(5)}
                      </text>
                    );
                  })}
                </svg>
              ) : (
                <div style={{ color: "var(--text-muted)", fontSize: 12, padding: 20, textAlign: "center" }}>
                  Need 2+ months of data
                </div>
              )}
            </div>
          </div>
        )}
      </>
      )}

      {/* Create form */}
      {showCreate && (
        <div style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--cyan-border)",
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
          animation: "slideUp 0.2s ease-out both",
        }}>
          <textarea
            value={newClaim}
            onChange={(e) => setNewClaim(e.target.value)}
            placeholder="What do you predict will happen?"
            rows={2}
            style={{
              width: "100%",
              background: "var(--bg-deep)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 8,
              color: "var(--text-primary-alt)",
              padding: "10px 14px",
              fontSize: 14,
              marginBottom: 10,
              resize: "vertical",
              fontFamily: "inherit",
              outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--cyan)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-subtle)"; }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              Confidence
              <input
                type="number"
                min="0" max="1" step="0.05"
                value={newConfidence}
                onChange={(e) => setNewConfidence(e.target.value)}
                style={{
                  width: 60,
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  color: "var(--text-body)",
                  padding: "6px 8px",
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </label>
            <select
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              style={{
                background: "var(--bg-deep)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                color: "var(--text-body)",
                padding: "6px 10px",
                fontSize: 12,
                outline: "none",
              }}
            >
              {["general", "technical", "product", "market", "personal", "political", "scientific"].map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <input
              type="date"
              value={newDeadline}
              onChange={(e) => setNewDeadline(e.target.value)}
              placeholder="Deadline"
              style={{
                background: "var(--bg-deep)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                color: "var(--text-body)",
                padding: "6px 10px",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              onClick={() => createMutation.mutate()}
              disabled={!newClaim.trim() || createMutation.isPending}
              style={{
                background: "var(--cyan)",
                color: "var(--black)",
                border: "none",
                borderRadius: 6,
                padding: "7px 18px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                opacity: !newClaim.trim() || createMutation.isPending ? 0.5 : 1,
              }}
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                background: statusFilter === s ? "var(--cyan-bg)" : "transparent",
                color: statusFilter === s ? "var(--cyan)" : "var(--text-muted)",
                border: "1px solid " + (statusFilter === s ? "var(--cyan-border)" : "transparent"),
                borderRadius: 20,
                padding: "5px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {domains.map((d) => (
            <button
              key={d}
              onClick={() => setDomainFilter(d)}
              style={{
                background: domainFilter === d ? "var(--cyan-bg)" : "transparent",
                color: domainFilter === d ? (DOMAIN_COLORS[d] ?? "var(--cyan)") : "var(--text-muted)",
                border: "1px solid " + (domainFilter === d ? "var(--cyan-border)" : "transparent"),
                borderRadius: 20,
                padding: "5px 14px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Predictions list */}
      {predictions.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
          No predictions found. Create one to start tracking your forecasting accuracy.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {predictions.map((p: Prediction) => {
            const sc = STATUS_COLORS[p.status] ?? STATUS_COLORS.open;
            const isExpanded = expandedId === p.id;
            const isResolving = resolveId === p.id;
            const isOverdue = p.status === "open" && p.deadline && new Date(p.deadline) < new Date();

            return (
              <div
                key={p.id}
                style={{
                  background: "var(--bg-surface)",
                  border: `1px solid ${isExpanded ? "var(--cyan-border)" : isOverdue ? "var(--red-border-dim)" : "var(--border-subtle)"}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  transition: "border-color 0.2s",
                }}
              >
                {/* Prediction header */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                  style={{
                    padding: "14px 18px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--cyan-bg-faint)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  {/* Resolution indicator */}
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: p.resolution ? (RESOLUTION_COLORS[p.resolution] ?? "var(--text-muted)") : (DOMAIN_COLORS[p.domain] ?? "var(--text-muted)"),
                    flexShrink: 0,
                  }} />

                  {/* Claim */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--text-primary-alt)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {p.claim}
                    </div>
                  </div>

                  {/* Confidence */}
                  <div style={{ flexShrink: 0, width: 90 }}>
                    {confidenceBar(p.confidence)}
                  </div>

                  {/* Status badge */}
                  <span style={{
                    background: sc.bg,
                    color: sc.color,
                    padding: "3px 10px",
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "capitalize",
                    flexShrink: 0,
                  }}>
                    {isOverdue ? "overdue" : p.status}
                  </span>

                  {/* Time */}
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                    {timeAgo(p.updated_at)}
                  </span>

                  {/* Chevron */}
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
                    style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: "0 18px 18px", borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
                    {/* Claim full text */}
                    <div style={{ fontSize: 13, color: "var(--text-body)", lineHeight: 1.6, marginBottom: 16, whiteSpace: "pre-wrap" }}>
                      {p.claim}
                    </div>

                    {/* Metadata row */}
                    <div style={{ display: "flex", gap: 20, fontSize: 12, color: "var(--text-muted)", marginBottom: 16, flexWrap: "wrap" }}>
                      <span>Domain: <strong style={{ color: DOMAIN_COLORS[p.domain] ?? "var(--text-muted)", textTransform: "capitalize" }}>{p.domain}</strong></span>
                      <span>Confidence: <strong style={{ color: "var(--text-primary-alt)" }}>{Math.round(p.confidence * 100)}%</strong></span>
                      {p.deadline && <span>Deadline: <strong style={{ color: isOverdue ? "var(--red)" : "var(--text-primary-alt)" }}>{new Date(p.deadline).toLocaleDateString()}</strong></span>}
                      <span>Created: {timeAgo(p.created_at)}</span>
                      {p.resolution && <span>Resolution: <strong style={{ color: RESOLUTION_COLORS[p.resolution], textTransform: "capitalize" }}>{p.resolution}</strong></span>}
                    </div>

                    {/* Resolution notes */}
                    {p.resolution_notes && (
                      <div style={{
                        background: "var(--bg-deep)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 6,
                        padding: "8px 12px",
                        fontSize: 12,
                        color: "var(--text-secondary-alt)",
                        lineHeight: 1.5,
                        marginBottom: 16,
                      }}>
                        {p.resolution_notes}
                      </div>
                    )}

                    {/* Resolve form */}
                    {isResolving && (
                      <div style={{
                        background: "var(--bg-deep)",
                        border: "1px solid var(--cyan-border)",
                        borderRadius: 8,
                        padding: 14,
                        marginBottom: 16,
                        animation: "slideUp 0.2s ease-out both",
                      }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                          {(["true", "false", "partial"] as const).map((r) => (
                            <button
                              key={r}
                              onClick={() => setResolveResolution(r)}
                              style={{
                                background: resolveResolution === r ? (RESOLUTION_COLORS[r] + "22") : "transparent",
                                color: resolveResolution === r ? RESOLUTION_COLORS[r] : "var(--text-muted)",
                                border: `1px solid ${resolveResolution === r ? RESOLUTION_COLORS[r] : "var(--border-subtle)"}`,
                                borderRadius: 6,
                                padding: "5px 14px",
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: "pointer",
                                textTransform: "capitalize",
                              }}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                        <input
                          value={resolveNotes}
                          onChange={(e) => setResolveNotes(e.target.value)}
                          placeholder="Resolution notes (optional)..."
                          style={{
                            width: "100%",
                            background: "var(--bg-surface)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: 6,
                            color: "var(--text-body)",
                            padding: "8px 12px",
                            fontSize: 12,
                            marginBottom: 10,
                            outline: "none",
                          }}
                        />
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            onClick={() => resolveMutation.mutate()}
                            disabled={resolveMutation.isPending}
                            style={{
                              background: "var(--cyan)",
                              color: "var(--black)",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 16px",
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: "pointer",
                              opacity: resolveMutation.isPending ? 0.5 : 1,
                            }}
                          >
                            {resolveMutation.isPending ? "Resolving..." : "Resolve"}
                          </button>
                          <button
                            onClick={() => { setResolveId(null); setResolveNotes(""); }}
                            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {p.status === "open" && (
                        <button
                          onClick={() => setResolveId(isResolving ? null : p.id)}
                          style={{
                            background: "var(--emerald-bg)",
                            color: "var(--emerald)",
                            border: "1px solid var(--emerald-border)",
                            borderRadius: 6,
                            padding: "5px 14px",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Resolve
                        </button>
                      )}
                      {p.status === "open" && (
                        <button
                          onClick={() => confirmToast("Void this prediction?", () => voidMutation.mutate(p.id))}
                          style={{
                            background: "var(--amber-bg-subtle)",
                            color: "var(--amber)",
                            border: "1px solid var(--amber-border-dim)",
                            borderRadius: 6,
                            padding: "5px 14px",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Void
                        </button>
                      )}
                      <button
                        onClick={() => confirmToast("Delete this prediction?", () => deleteMutation.mutate(p.id))}
                        style={{
                          background: "var(--red-dim)",
                          color: "var(--red)",
                          border: "1px solid var(--red-border-dim)",
                          borderRadius: 6,
                          padding: "5px 14px",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
