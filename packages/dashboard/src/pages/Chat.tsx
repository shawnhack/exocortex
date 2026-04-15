import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Memory } from "../api/client";
import { useToast } from "../components/Toast";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Memory[];
}

export function Chat() {
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Check if API key is configured
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const hasApiKey = settings && (settings["ai.api_key"] || settings["ai.apiKey"]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);

    try {
      // Send prior messages as history for multi-turn context
      const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }));
      const response = await api.chat(msg, history, conversationId);
      setConversationId(response.conversation_id);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: response.response, sources: response.sources },
      ]);
    } catch (err) {
      toast((err as Error).message, "error");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I encountered an error processing your request." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (!hasApiKey) {
    return (
      <div>
        <h1>Chat</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
          Ask questions about your memories using RAG
        </p>
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--amber-border)",
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--amber)", marginBottom: 12, fontWeight: 600 }}>
            API Key Required
          </div>
          <p style={{ color: "var(--text-secondary-alt)", fontSize: 13, marginBottom: 16 }}>
            Chat requires an AI API key. Configure it in Settings under the "ai" section.
          </p>
          <Link
            to="/settings"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--cyan-bg)",
              color: "var(--cyan)",
              border: "1px solid var(--cyan-border)",
              borderRadius: 8,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              transition: "all 0.15s",
            }}
          >
            Go to Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 64px)" }}>
      <h1>Chat</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Ask questions about your memories
      </p>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          paddingBottom: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
            <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block" }}>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p style={{ fontSize: 14 }}>Ask a question about your memories</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>Your memories will be searched for relevant context</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            <div
              style={{
                display: "flex",
                justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  maxWidth: "80%",
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  background: msg.role === "user"
                    ? "linear-gradient(135deg, var(--cyan-border-dim), var(--cyan-bg-active))"
                    : "var(--bg-surface)",
                  border: `1px solid ${msg.role === "user" ? "var(--cyan-border)" : "var(--border-subtle)"}`,
                  color: "var(--text-primary-alt)",
                }}
              >
                {msg.content}
              </div>
            </div>

            {/* Sources */}
            {msg.sources && msg.sources.length > 0 && (
              <div style={{ marginTop: 8, paddingLeft: 4 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
                  Sources ({msg.sources.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {msg.sources.map((source) => (
                    <Link
                      key={source.id}
                      to={`/memory/${source.id}`}
                      style={{
                        background: "var(--cyan-bg-selected)",
                        border: "1px solid var(--cyan-border-faint)",
                        borderRadius: 8,
                        padding: "6px 10px",
                        fontSize: 11,
                        color: "var(--text-body)",
                        textDecoration: "none",
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        transition: "border-color 0.15s",
                      }}
                    >
                      <span style={{ color: "var(--cyan)", fontFamily: "var(--font-mono)", marginRight: 8 }}>
                        {source.id.slice(0, 10)}
                      </span>
                      {source.content.slice(0, 80)}{source.content.length > 80 ? "..." : ""}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0" }}>
            <div className="spinner" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Thinking...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 0",
          borderTop: "1px solid #16163a",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Ask about your memories..."
          style={{
            flex: 1,
            padding: "12px 16px",
            borderRadius: 10,
            border: "1px solid #16163a",
            background: "var(--bg-surface)",
            color: "var(--text-primary-alt)",
            fontSize: 14,
            outline: "none",
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--cyan-border-strong)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-subtle)"; }}
          disabled={loading}
        />
        <button
          className="btn-primary"
          onClick={handleSend}
          disabled={!input.trim() || loading}
          style={{
            padding: "12px 20px",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          Send
        </button>
      </div>
    </div>
  );
}
