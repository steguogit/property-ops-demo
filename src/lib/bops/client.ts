// Client-side API helpers + shared types for the Control Room UI.
// Run identity (runId + token) is kept in sessionStorage so a browser tab is a
// single demo run; a fresh tab / reset creates a new isolated run.
"use client";

const RUN_KEY = "bops.runId";
const TOKEN_KEY = "bops.token";

export function getStoredRun(): { runId: string | null; token: string | null } {
  if (typeof window === "undefined") return { runId: null, token: null };
  return {
    runId: sessionStorage.getItem(RUN_KEY),
    token: sessionStorage.getItem(TOKEN_KEY),
  };
}
export function storeRun(runId: string, token: string) {
  sessionStorage.setItem(RUN_KEY, runId);
  sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearStoredRun() {
  sessionStorage.removeItem(RUN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`);
  return data as T;
}

export const bopsApi = {
  runAction(body: Record<string, unknown>) {
    return jsonFetch<any>("/api/bops/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  overview(runId: string) {
    return jsonFetch<any>(`/api/bops/overview?runId=${encodeURIComponent(runId)}`);
  },
  telemetry(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    return jsonFetch<any>(`/api/bops/telemetry?${qs}`);
  },
  events(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    return jsonFetch<any>(`/api/bops/events?${qs}`);
  },
  incidents(runId: string, incidentId?: string) {
    const qs = new URLSearchParams({ runId, ...(incidentId ? { incidentId } : {}) });
    return jsonFetch<any>(`/api/bops/incidents?${qs}`);
  },
  incidentAction(body: Record<string, unknown>) {
    return jsonFetch<any>("/api/bops/incident-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  asset(assetId: string, runId: string) {
    return jsonFetch<any>(
      `/api/bops/asset?assetId=${encodeURIComponent(assetId)}&runId=${encodeURIComponent(runId)}`
    );
  },
  knowledge(params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    return jsonFetch<any>(`/api/bops/knowledge?${qs}`);
  },
  knowledgeDoc(docId: string) {
    return jsonFetch<any>(`/api/bops/knowledge/${encodeURIComponent(docId)}`);
  },
  underTheHood(runId: string, assetId: string) {
    return jsonFetch<any>(
      `/api/bops/under-the-hood?runId=${encodeURIComponent(runId)}&assetId=${encodeURIComponent(assetId)}`
    );
  },
};

export function fmtTime(iso: string | number | Date, tz = "Asia/Hong_Kong"): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export function fmtClock(iso: string | number | Date, tz = "Asia/Hong_Kong"): string {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(iso);
  }
}
