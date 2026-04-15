import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useCallback } from "react";
import { api, type EmbeddingHealth } from "../api/client";
import { useToast } from "../components/Toast";

type Tab = "config" | "data";

const BOOLEAN_KEYS = new Set([
  "importance.auto_adjust",
  "dedup.enabled",
  "chunking.enabled",
  "auto_tagging.enabled",
  "scoring.use_rrf",
]);

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  color: active ? "var(--text-primary-alt)" : "var(--text-muted)",
  background: active ? "var(--violet-dim)" : "transparent",
  border: "1px solid",
  borderColor: active ? "var(--cyan-border)" : "transparent",
  borderRadius: 8,
  cursor: "pointer",
  transition: "all 0.15s",
  fontFamily: "var(--font-mono)",
});

const toggleTrackStyle = (on: boolean): React.CSSProperties => ({
  width: 40,
  height: 22,
  borderRadius: 11,
  background: on ? "var(--cyan)" : "var(--bg-toggle-off)",
  border: "1px solid",
  borderColor: on ? "var(--cyan)" : "var(--border-toggle-off)",
  cursor: "pointer",
  position: "relative",
  transition: "background 0.2s, border-color 0.2s",
  flexShrink: 0,
});

const toggleKnobStyle = (on: boolean): React.CSSProperties => ({
  width: 16,
  height: 16,
  borderRadius: "50%",
  background: "var(--text-primary-alt)",
  position: "absolute",
  top: 2,
  left: on ? 20 : 2,
  transition: "left 0.2s",
  boxShadow: "var(--shadow-light)",
});

export function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("config");
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
    gcTime: 0,
  });

  const { data: embeddingHealth } = useQuery({
    queryKey: ["embedding-health"],
    queryFn: () => api.getEmbeddingHealth(),
    staleTime: 5 * 60 * 1000,
  });

  const reembedMutation = useMutation({
    mutationFn: () => api.triggerReembed(),
    onSuccess: (data) => {
      toast(`Reembedded ${data.processed} memories${data.failed > 0 ? ` (${data.failed} failed)` : ""}`, "success");
      queryClient.invalidateQueries({ queryKey: ["embedding-health"] });
    },
    onError: (err) => toast((err as Error).message, "error"),
  });

  const [edited, setEdited] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"json" | "lines">("json");

  useEffect(() => {
    if (settings) {
      const merged = { ...settings };
      for (const k of ["ai.provider", "ai.api_key", "ai.model"]) {
        if (!(k in merged)) merged[k] = "";
      }
      setEdited(merged);
    }
  }, [settings]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `exocortex-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }, []);

  const mutation = useMutation({
    mutationFn: (s: Record<string, string>) => api.updateSettings(s),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast("Settings saved", "success");
    },
  });

  // Clear the "Saved" indicator after 3 seconds
  useEffect(() => {
    if (mutation.isSuccess) {
      const timer = setTimeout(() => mutation.reset(), 3000);
      return () => clearTimeout(timer);
    }
  }, [mutation.isSuccess]);

  const importMutation = useMutation({
    mutationFn: (memories: Array<{ content: string; tags?: string[] }>) =>
      api.importMemories(memories),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["recent"] });
    },
  });

  const handleImport = () => {
    let memories: Array<{ content: string; tags?: string[] }>;

    if (importFormat === "json") {
      try {
        const parsed = JSON.parse(importText);
        memories = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        toast("Invalid JSON", "error");
        return;
      }
    } else {
      memories = importText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((content) => ({ content }));
    }

    if (memories.length === 0) {
      toast("No memories to import", "error");
      return;
    }

    importMutation.mutate(memories);
  };

  const isBooleanKey = (key: string) => BOOLEAN_KEYS.has(key);
  const isTrashPurgeKey = (key: string) => key === "trash.auto_purge_days";

  const getBoolValue = (key: string): boolean => {
    const v = edited[key];
    return v === "true" || v === "1";
  };

  const toggleBool = (key: string) => {
    const current = getBoolValue(key);
    setEdited((prev) => ({ ...prev, [key]: current ? "false" : "true" }));
  };

  const getTrashPurgeEnabled = (): boolean => {
    const v = edited["trash.auto_purge_days"];
    return v !== "0" && v !== "";
  };

  const getTrashPurgeDays = (): string => {
    const v = edited["trash.auto_purge_days"];
    if (!v || v === "0") return "30";
    return v;
  };

  if (isLoading)
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );

  const placeholders: Record<string, string> = {
    "ai.provider": "anthropic or openai",
    "ai.api_key": "sk-...",
    "ai.model": "claude-sonnet-4-5-20250929 or gpt-4o-mini",
  };

  const groups: Record<string, string[]> = {};
  for (const key of Object.keys(edited)) {
    const group = key.split(".")[0];
    if (!groups[group]) groups[group] = [];
    groups[group].push(key);
  }

  const renderToggle = (on: boolean, onToggle: () => void) => (
    <div
      role="switch"
      aria-checked={on}
      tabIndex={0}
      style={toggleTrackStyle(on)}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
    >
      <div style={toggleKnobStyle(on)} />
    </div>
  );

  const renderSettingRow = (key: string) => {
    if (isTrashPurgeKey(key)) {
      const enabled = getTrashPurgeEnabled();
      return (
        <div
          key={key}
          style={{
            marginBottom: 12,
            display: "flex",
            gap: 16,
            alignItems: "center",
          }}
        >
          <label
            style={{
              width: 220,
              fontSize: 12,
              color: "var(--text-muted)",
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
            }}
          >
            {key}
          </label>
          {renderToggle(enabled, () => {
            setEdited((prev) => ({
              ...prev,
              [key]: enabled ? "0" : "30",
            }));
          })}
          {enabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="number"
                min="1"
                value={getTrashPurgeDays()}
                onChange={(e) =>
                  setEdited((prev) => ({ ...prev, [key]: e.target.value || "1" }))
                }
                style={{
                  width: 70,
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border-subtle)",
                  background: "var(--bg-surface-hover)",
                  color: "var(--text-primary-alt)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  outline: "none",
                  transition: "border-color 0.2s, box-shadow 0.2s",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--cyan)";
                  e.currentTarget.style.boxShadow = "var(--glow-cyan-focus-strong)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-subtle)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>days</span>
            </div>
          )}
          {!enabled && (
            <span style={{ fontSize: 12, color: "var(--text-disabled)" }}>Disabled</span>
          )}
        </div>
      );
    }

    if (isBooleanKey(key)) {
      const on = getBoolValue(key);
      return (
        <div
          key={key}
          style={{
            marginBottom: 12,
            display: "flex",
            gap: 16,
            alignItems: "center",
          }}
        >
          <label
            style={{
              width: 220,
              fontSize: 12,
              color: "var(--text-muted)",
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
            }}
          >
            {key}
          </label>
          {renderToggle(on, () => toggleBool(key))}
          <span style={{ fontSize: 12, color: on ? "var(--green)" : "var(--text-disabled)" }}>
            {on ? "Enabled" : "Disabled"}
          </span>
        </div>
      );
    }

    // Default: text input
    return (
      <div
        key={key}
        style={{
          marginBottom: 12,
          display: "flex",
          gap: 16,
          alignItems: "center",
        }}
      >
        <label
          style={{
            width: 220,
            fontSize: 12,
            color: "var(--text-muted)",
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
          }}
        >
          {key}
        </label>
        <input
          type={key.toLowerCase().includes("api_key") ? "password" : "text"}
          value={edited[key] ?? ""}
          placeholder={placeholders[key]}
          onChange={(e) =>
            setEdited((prev) => ({ ...prev, [key]: e.target.value }))
          }
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-surface-hover)",
            color: "var(--text-primary-alt)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            outline: "none",
            transition: "border-color 0.2s, box-shadow 0.2s",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--cyan)";
            e.currentTarget.style.boxShadow = "var(--glow-cyan-focus-strong)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border-subtle)";
            e.currentTarget.style.boxShadow = "none";
          }}
        />
      </div>
    );
  };

  return (
    <div>
      <h1>Settings</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
        System configuration
      </p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
        <button style={tabStyle(tab === "config")} onClick={() => setTab("config")}>
          Configuration
        </button>
        <button style={tabStyle(tab === "data")} onClick={() => setTab("data")}>
          Data
        </button>
      </div>

      {/* Configuration Tab */}
      {tab === "config" && (
        <div>
          {/* Embedding Health */}
          {embeddingHealth && (
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 12,
                padding: 20,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--cyan)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 16,
                  fontFamily: "var(--font-mono)",
                }}
              >
                Embedding Status
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                <div style={{ background: "var(--bg-overlay-light)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "12px 16px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Model</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary-alt)", fontFamily: "var(--font-mono)" }}>
                    {embeddingHealth.currentModel}
                  </div>
                </div>
                <div style={{ background: "var(--bg-overlay-light)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "12px 16px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Embedded</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "var(--emerald)", fontFamily: "var(--font-mono)" }}>
                    {embeddingHealth.totalEmbedded}
                  </div>
                </div>
                <div style={{ background: "var(--bg-overlay-light)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "12px 16px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Mismatched Model</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: embeddingHealth.mismatchedModel > 0 ? "var(--warning)" : "var(--emerald)", fontFamily: "var(--font-mono)" }}>
                    {embeddingHealth.mismatchedModel}
                  </div>
                </div>
              </div>
              {embeddingHealth.missingEmbedding > 0 && (
                <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--warning-bg-subtle)", border: "1px solid var(--warning-border)", borderRadius: 8, fontSize: 12, color: "var(--warning)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>{embeddingHealth.missingEmbedding} memories missing embeddings</span>
                  <button
                    onClick={() => reembedMutation.mutate()}
                    disabled={reembedMutation.isPending}
                    style={{
                      padding: "4px 12px",
                      fontSize: 11,
                      fontWeight: 600,
                      border: "1px solid var(--warning-border-strong)",
                      borderRadius: 6,
                      cursor: reembedMutation.isPending ? "wait" : "pointer",
                      background: "var(--warning-bg)",
                      color: "var(--warning)",
                      fontFamily: "var(--font-mono)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      opacity: reembedMutation.isPending ? 0.6 : 1,
                    }}
                  >
                    {reembedMutation.isPending && <span className="spinner" style={{ width: 10, height: 10 }} />}
                    {reembedMutation.isPending ? "Reembedding..." : "Reembed Now"}
                  </button>
                </div>
              )}
            </div>
          )}

          {Object.entries(groups).map(([group, keys]) => (
            <div
              key={group}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 12,
                padding: 20,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--cyan)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 16,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {group}
              </div>

              {keys.map((key) => renderSettingRow(key))}
            </div>
          ))}

          <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 8 }}>
            <button
              className="btn-primary"
              onClick={() => mutation.mutate(edited)}
              disabled={mutation.isPending}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              {mutation.isPending && <span className="spinner" style={{ width: 14, height: 14 }} />}
              {mutation.isPending ? "Saving..." : "Save"}
            </button>
            {mutation.isSuccess && (
              <span style={{ color: "var(--green)", fontSize: 13 }}>Saved</span>
            )}
            {mutation.isError && (
              <span style={{ color: "var(--red)", fontSize: 13 }}>
                Error: {(mutation.error as Error).message}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Data Tab (Export + Import) */}
      {tab === "data" && (
        <div>
          {/* Export Section */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--cyan)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 12,
                fontFamily: "var(--font-mono)",
              }}
            >
              Export
            </div>
            <p style={{ color: "var(--text-secondary-alt)", fontSize: 13, marginBottom: 16 }}>
              Download a full JSON backup of all memories, entities, and settings.
            </p>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <button
                className="btn-secondary"
                onClick={handleExport}
                disabled={exporting}
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                {exporting && <span className="spinner" style={{ width: 14, height: 14 }} />}
                {exporting ? "Exporting..." : "Export Data"}
              </button>
              {exportError && (
                <span style={{ color: "var(--red)", fontSize: 13 }}>
                  Error: {exportError}
                </span>
              )}
            </div>
          </div>

          {/* Divider */}
          <div
            style={{
              height: 1,
              background: "linear-gradient(90deg, transparent, #16163a 20%, #16163a 80%, transparent)",
              margin: "24px 0",
            }}
          />

          {/* Import Section */}
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 12,
              padding: 24,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--cyan)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 12,
                fontFamily: "var(--font-mono)",
              }}
            >
              Import
            </div>
            <p style={{ color: "var(--text-secondary-alt)", fontSize: 13, marginBottom: 16 }}>
              Bulk import memories from text.
            </p>

            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button
                className={`format-pill${importFormat === "json" ? " active" : ""}`}
                onClick={() => setImportFormat("json")}
              >
                JSON
              </button>
              <button
                className={`format-pill${importFormat === "lines" ? " active" : ""}`}
                onClick={() => setImportFormat("lines")}
              >
                One per line
              </button>
            </div>

            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={
                importFormat === "json"
                  ? '[{"content": "Memory text", "tags": ["tag1"]}]'
                  : "One memory per line..."
              }
              rows={10}
              style={{
                width: "100%",
                padding: 16,
                borderRadius: 12,
                border: "1px solid var(--border-subtle)",
                background: "var(--bg-surface-hover)",
                color: "var(--text-primary-alt)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                resize: "vertical",
                lineHeight: 1.6,
                outline: "none",
                transition: "border-color 0.2s, box-shadow 0.2s",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--cyan)";
                e.currentTarget.style.boxShadow = "var(--glow-cyan-focus-strong)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-subtle)";
                e.currentTarget.style.boxShadow = "none";
              }}
            />

            <div style={{ marginTop: 16, display: "flex", gap: 14, alignItems: "center" }}>
              <button
                className="btn-primary"
                onClick={handleImport}
                disabled={importMutation.isPending || !importText.trim()}
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                {importMutation.isPending && <span className="spinner" style={{ width: 14, height: 14 }} />}
                {importMutation.isPending ? "Importing..." : "Import"}
              </button>

              {importMutation.isSuccess && (
                <span style={{ color: "var(--green)", fontSize: 13 }}>
                  Imported {importMutation.data.imported} memories
                  {importMutation.data.failed > 0 && ` (${importMutation.data.failed} failed)`}
                </span>
              )}

              {importMutation.isError && (
                <span style={{ color: "var(--red)", fontSize: 13 }}>
                  Error: {(importMutation.error as Error).message}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
