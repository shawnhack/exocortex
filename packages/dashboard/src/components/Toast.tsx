import { createContext, useContext, useState, useCallback, useRef } from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  confirm?: { onAccept: () => void; onCancel?: () => void };
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
  confirmToast: (message: string, onAccept: () => void) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => removeToast(id), 4000);
  }, [removeToast]);

  const confirmToast = useCallback((message: string, onAccept: () => void) => {
    const id = nextId.current++;
    setToasts((prev) => [
      ...prev,
      { id, message, type: "info", confirm: { onAccept } },
    ]);
  }, []);

  return (
    <ToastContext.Provider value={{ toast, confirmToast }}>
      {children}
      {/* Toast container */}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 10000,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDismiss={() => removeToast(t.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TYPE_STYLES: Record<ToastType, { border: string; accent: string; icon: string }> = {
  success: { border: "rgba(74, 222, 128, 0.3)", accent: "#4ade80", icon: "M20 6L9 17l-5-5" },
  error: { border: "rgba(248, 113, 113, 0.3)", accent: "#f87171", icon: "M18 6L6 18M6 6l12 12" },
  info: { border: "rgba(34, 211, 238, 0.3)", accent: "#22d3ee", icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 14v-4m0-4h.01" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const style = TYPE_STYLES[toast.type];

  return (
    <div
      style={{
        background: "#0c0c1d",
        border: `1px solid ${style.border}`,
        borderRadius: 10,
        padding: "12px 16px",
        minWidth: 280,
        maxWidth: 400,
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
        animation: "toastSlideIn 0.25s ease-out",
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={style.accent}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        <path d={style.icon} />
      </svg>
      <div style={{ flex: 1 }}>
        <div style={{ color: "#e8e8f4", fontSize: 13, lineHeight: 1.5 }}>
          {toast.message}
        </div>
        {toast.confirm && (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              className="btn-danger btn-sm"
              onClick={() => {
                toast.confirm!.onAccept();
                onDismiss();
              }}
            >
              Confirm
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={onDismiss}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {!toast.confirm && (
        <button
          onClick={onDismiss}
          style={{
            background: "none",
            border: "none",
            color: "#8080a0",
            cursor: "pointer",
            padding: 0,
            fontSize: 16,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      )}
    </div>
  );
}
