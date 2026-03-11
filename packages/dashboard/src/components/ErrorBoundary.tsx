import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, maxWidth: 600 }}>
          <h2 style={{ color: "var(--text-primary-alt)", fontSize: 18, marginBottom: 12 }}>Something went wrong</h2>
          <pre
            style={{
              color: "var(--error)",
              fontSize: 13,
              background: "rgba(255,107,107,0.08)",
              padding: 16,
              borderRadius: 8,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16,
              padding: "8px 20px",
              background: "var(--violet-dim)",
              color: "var(--cyan-pure)",
              border: "1px solid var(--cyan-border)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
