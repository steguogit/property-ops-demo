"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Lightweight global toast/notification system. Used to surface backend
// failures (e.g. an Atlas connection timeout when creating a conversation) with
// a clear, friendly, dismissable message instead of a silent no-op.
// ---------------------------------------------------------------------------

export type ToastKind = "error" | "warn" | "info" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Auto-dismiss after this many ms (0 = sticky until dismissed). */
  duration?: number;
}

interface ToastApi {
  push: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
  /** Convenience: turn an unknown error into a friendly toast. */
  error: (title: string, err?: unknown) => number;
  info: (title: string, message?: string) => number;
  success: (title: string, message?: string) => number;
}

const ToastCtx = createContext<ToastApi | null>(null);

let nextId = 1;

/**
 * Translate low-level / network errors into a human-friendly explanation.
 * Connection timeouts, DNS failures and 5xx responses are common when the Atlas
 * cluster is unreachable (e.g. IP not allow-listed, cluster paused, or a cold
 * serverless connection), so we call that out explicitly.
 */
export function friendlyError(err?: unknown): string {
  const raw =
    err == null
      ? ""
      : typeof err === "string"
      ? err
      : (err as Error)?.message ?? String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("server selection") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("socket") ||
    lower.includes("topology") ||
    lower.includes("no primary") ||
    lower.includes("connection") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror")
  ) {
    return (
      "Couldn't reach the MongoDB Atlas database. This is usually a connection " +
      "timeout — check that the cluster is running and your IP is allow-listed " +
      "in Atlas → Network Access, then try again." +
      (raw ? `\n\nDetails: ${raw}` : "")
    );
  }
  if (lower.includes("500") || lower.includes("internal server error")) {
    return (
      "The server hit an error handling that request. It may be a temporary " +
      "database hiccup — please try again in a moment." +
      (raw ? `\n\nDetails: ${raw}` : "")
    );
  }
  return raw || "Something went wrong. Please try again.";
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId++;
      const duration = t.duration ?? (t.kind === "error" ? 9000 : 4500);
      setToasts((ts) => [...ts, { ...t, id }]);
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss]
  );

  const error = useCallback(
    (title: string, err?: unknown) =>
      push({ kind: "error", title, message: friendlyError(err) }),
    [push]
  );
  const info = useCallback(
    (title: string, message?: string) => push({ kind: "info", title, message }),
    [push]
  );
  const success = useCallback(
    (title: string, message?: string) =>
      push({ kind: "success", title, message }),
    [push]
  );

  return (
    <ToastCtx.Provider value={{ push, dismiss, error, info, success }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.kind}`} key={t.id}>
            <span className="toast-ico" aria-hidden>
              {t.kind === "error"
                ? "⚠"
                : t.kind === "warn"
                ? "!"
                : t.kind === "success"
                ? "✓"
                : "ℹ"}
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-message">{t.message}</div>}
            </div>
            <button
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Fail-safe no-op API so a component can call useToast() even if (in a test
    // or isolated render) the provider isn't mounted.
    return {
      push: () => 0,
      dismiss: () => {},
      error: () => 0,
      info: () => 0,
      success: () => 0,
    };
  }
  return ctx;
}
