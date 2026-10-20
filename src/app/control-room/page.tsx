"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bopsApi,
  getStoredRun,
  storeRun,
  clearStoredRun,
  fmtTime,
  fmtClock,
} from "@/lib/bops/client";
import { ZoneMap } from "@/components/bops/ZoneMap";
import { DetailPanel } from "@/components/bops/DetailPanel";
import { SIGNAL_META, SEVERITY_META } from "@/components/bops/SignalColors";

const POLL_MS = 5000;

export default function ControlRoom() {
  const [runId, setRunId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [showHood, setShowHood] = useState(false);
  const [hood, setHood] = useState<any>(null);
  const [evFilter, setEvFilter] = useState({ severity: "", zoneId: "", system: "", eventType: "" });
  const pollRef = useRef<any>(null);

  // Bootstrap: reuse the tab's run, else create one.
  useEffect(() => {
    const stored = getStoredRun();
    if (stored.runId && stored.token) {
      setRunId(stored.runId);
      setToken(stored.token);
    } else {
      void createRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createRun() {
    setBusy(true);
    try {
      const r = await bopsApi.runAction({ action: "create" });
      storeRun(r.runId, r.token);
      setRunId(r.runId);
      setToken(r.token);
      setConnError(null);
    } catch (e) {
      setConnError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const ov = await bopsApi.overview(runId);
      setOverview(ov);
      const params: Record<string, string> = { runId, limit: "40" };
      for (const [k, v] of Object.entries(evFilter)) if (v) params[k] = v;
      const ev = await bopsApi.events(params);
      setEvents(ev.events || []);
      setConnError(null);
      setLastRefresh(Date.now());
    } catch (e) {
      setConnError((e as Error).message);
    }
  }, [runId, evFilter]);

  useEffect(() => {
    if (!runId) return;
    void refresh();
    pollRef.current = setInterval(refresh, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [runId, refresh]);

  async function control(action: string, extra: Record<string, unknown> = {}) {
    if (!runId || !token) return;
    setBusy(true);
    try {
      await bopsApi.runAction({ action, runId, token, ...extra });
      await refresh();
    } catch (e) {
      setConnError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    setBusy(true);
    try {
      const r = await bopsApi.runAction({ action: "reset", runId, token });
      storeRun(r.runId, r.token);
      setRunId(r.runId);
      setToken(r.token);
      setSelected(null);
      setOverview(null);
      setEvents([]);
    } catch (e) {
      setConnError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openHood() {
    setShowHood(true);
    try {
      setHood(await bopsApi.underTheHood(runId!, selected || "CHILLER-01"));
    } catch (e) {
      setHood({ error: (e as Error).message });
    }
  }

  const sum = overview?.summary;
  const staleFeed = lastRefresh && Date.now() - lastRefresh > POLL_MS * 2.5;

  return (
    <div className="app bops-app">
      <header className="header bops-header">
        <div className="brand">
          <div className="leaf">BO</div>
          <div>
            <h1>Building Operations Control Room</h1>
            <div className="bops-subtitle">
              {overview?.building ? `${overview.building.siteName} · ${overview.building.buildingName}` : "Harbourgate Commercial Tower"}
              {" · "}
              <span className="bops-synthetic">Synthetic telemetry · real MongoDB storage & processing</span>
            </div>
          </div>
        </div>
        <div className="bops-header-right">
          <a href="/" className="bops-link-back">← Retrieval demo</a>
          <div className="bops-run-pill" title="Demo run (isolated session)">
            run {runId ? runId.slice(0, 14) : "…"}
          </div>
        </div>
      </header>

      {connError && (
        <div className="bops-banner bops-banner-error">
          Database / API error: {connError}. Base functionality may be degraded.
          <button className="bops-btn-sm" onClick={createRun}>Retry</button>
        </div>
      )}

      {/* Presenter controls */}
      <section className="bops-controls" aria-label="Presenter controls">
        <span className="bops-controls-label">Presenter</span>
        {sum?.simulatorStatus === "running" ? (
          <button className="bops-btn" disabled={busy} onClick={() => control("pause")}>⏸ Pause simulation</button>
        ) : (
          <button className="bops-btn" disabled={busy} onClick={() => control("start")}>▶ Start simulation</button>
        )}
        <button className="bops-btn bops-btn-warn" disabled={busy || sum?.faultActive} onClick={() => control("inject_fault")}>
          ⚡ Run chiller scenario
        </button>
        <button className="bops-btn" disabled={busy} onClick={() => control("enable_signal", { assetId: "CHILLER-01", signalKey: "differentialPressureKpa" })}>
          ＋ Enable differential pressure
        </button>
        <button className="bops-btn bops-btn-ok" disabled={busy || !sum?.faultActive} onClick={() => control("recover")}>
          ✔ Recover equipment
        </button>
        <button className="bops-btn" disabled={busy} onClick={doReset}>⟲ Reset / replay</button>
        <button className="bops-btn-ghost" onClick={openHood}>Under the hood</button>
      </section>

      {/* Summary */}
      <section className="bops-summary" aria-label="Summary">
        <SummaryCard label="Active incidents" value={sum?.activeIncidents ?? "—"} alert={(sum?.activeIncidents ?? 0) > 0} />
        <SummaryCard label="Assets reporting" value={sum ? `${sum.assetsReporting}/${sum.assetsTotalMechanical}` : "—"} />
        <SummaryCard
          label="Monitored equipment power"
          value={sum ? `${sum.monitoredEquipmentPowerKw} kW` : "—"}
          sub={sum ? `${sum.powerReportingCount} asset(s) · instantaneous, not kWh` : undefined}
        />
        <SummaryCard
          label="Simulator / feed"
          value={sum?.simulatorStatus ?? "—"}
          sub={
            sum
              ? sum.simulatorStatus === "paused"
                ? "paused — data will go stale"
                : staleFeed
                ? "feed stale"
                : `live · refresh ${POLL_MS / 1000}s`
              : undefined
          }
          alert={sum?.simulatorStatus === "paused" || !!staleFeed}
        />
      </section>

      <div className="bops-main">
        <div className="bops-left">
          {/* Zone schematic */}
          <section className="bops-panel">
            <div className="bops-panel-head">
              <h2>Building zones</h2>
              <span className="bops-tiny">{overview ? `server ${fmtClock(overview.serverTime)}` : ""}</span>
            </div>
            {overview ? (
              <ZoneMap
                assets={overview.assets.map((a: any) => ({
                  assetId: a.assetId,
                  type: a.type,
                  zoneId: a.zoneId,
                  hasIncident: a.hasIncident,
                  reporting: a.reporting,
                  measurementsNormal: a.measurementsNormal,
                }))}
                selectedAssetId={selected}
                onSelect={setSelected}
              />
            ) : (
              <div className="bops-state">Loading building…</div>
            )}
          </section>

          {/* Asset cards */}
          <section className="bops-panel">
            <div className="bops-panel-head"><h2>Assets</h2></div>
            <div className="bops-cards">
              {overview?.assets?.map((a: any) => (
                <button
                  key={a.assetId}
                  className={`bops-card ${a.hasIncident ? (a.measurementsNormal ? "incident-recovered" : "incident") : ""} ${selected === a.assetId ? "sel" : ""}`}
                  onClick={() => setSelected(a.assetId)}
                >
                  <div className="bops-card-head">
                    <span className="bops-card-name">{a.name}</span>
                    {a.hasIncident && (
                      <span className="bops-card-alert">
                        ▲ {a.measurementsNormal ? "incident open" : "incident"}
                      </span>
                    )}
                  </div>
                  <div className="bops-card-sub">{a.assetId} · {a.zoneName}</div>
                  {a.hasIncident && a.measurementsNormal && (
                    <div className="bops-card-recovered">
                      ● measurements normal · incident awaits resolve/dismiss
                    </div>
                  )}
                  <div className="bops-card-body">
                    {a.points.length === 0 ? (
                      <span className="bops-tiny">security device · event-based</span>
                    ) : a.latest && !a.stale ? (
                      a.points.slice(0, 3).map((p: any) => (
                        <span className="bops-card-metric" key={p.key}>
                          {SIGNAL_META[p.key]?.label ?? p.label}:{" "}
                          <strong>{typeof a.latest.values[p.key] === "number" ? a.latest.values[p.key] : "—"}</strong> {p.unit}
                        </span>
                      ))
                    ) : (
                      <span className="bops-unavail">{a.stale ? "stale data" : "no data"}</span>
                    )}
                  </div>
                  <div className="bops-card-foot">
                    {a.latest ? (
                      <span className={a.stale ? "bops-dot-stale" : "bops-dot-live"}>
                        {a.stale ? "⚠ stale" : "● live"} · {fmtClock(a.latest.ts)}
                      </span>
                    ) : (
                      <span className="bops-dot-stale">no feed</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* Event feed */}
          <section className="bops-panel">
            <div className="bops-panel-head">
              <h2>Recent events</h2>
            </div>
            <div className="bops-evfilters">
              <select aria-label="Severity filter" value={evFilter.severity} onChange={(e) => setEvFilter((f) => ({ ...f, severity: e.target.value }))}>
                <option value="">All severities</option>
                {["critical", "high", "medium", "low", "info"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select aria-label="Zone filter" value={evFilter.zoneId} onChange={(e) => setEvFilter((f) => ({ ...f, zoneId: e.target.value }))}>
                <option value="">All zones</option>
                <option value="ZONE-B2-PLANT">B2 Plant</option>
                <option value="ZONE-L10-AHU">L10 AHU</option>
                <option value="ZONE-GF-LOBBY">GF Lobby</option>
              </select>
              <select aria-label="System filter" value={evFilter.system} onChange={(e) => setEvFilter((f) => ({ ...f, system: e.target.value }))}>
                <option value="">All systems</option>
                <option value="security">Security</option>
                <option value="chilled_water">Chilled water</option>
                <option value="air_handling">Air handling</option>
              </select>
              <select aria-label="Event type filter" value={evFilter.eventType} onChange={(e) => setEvFilter((f) => ({ ...f, eventType: e.target.value }))}>
                <option value="">All types</option>
                <option value="door_held_open">Door held open</option>
                <option value="access_granted">Access granted</option>
                <option value="access_denied">Access denied</option>
                <option value="device_health">Device health</option>
              </select>
            </div>
            <ul className="bops-events">
              {events.length === 0 && <li className="bops-state">No events{Object.values(evFilter).some(Boolean) ? " match the filters" : " yet"}.</li>}
              {events.map((e) => (
                <li key={e.eventId} className="bops-event">
                  <span className="bops-ev-sev" style={{ color: SEVERITY_META[e.severity]?.color }}>
                    {SEVERITY_META[e.severity]?.icon} {e.severity}
                  </span>
                  <span className="bops-ev-main">{e.eventType.replace(/_/g, " ")}</span>
                  <span className="bops-ev-zone">{e.zoneId} · {e.system}</span>
                  <span className="bops-ev-time">{fmtTime(e.eventTime)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="bops-right">
          {selected && runId && token ? (
            <DetailPanel
              runId={runId}
              token={token}
              assetId={selected}
              onClose={() => setSelected(null)}
              onChanged={refresh}
            />
          ) : (
            <aside className="bops-detail bops-detail-empty">
              <p>Select an asset or incident to inspect measurements, detection evidence, related events, specifications, and knowledge retrieval.</p>
              <p className="bops-tiny">Normal state is intentionally calm. Run the chiller scenario to generate a backend-detected incident.</p>
            </aside>
          )}
        </div>
      </div>

      {showHood && (
        <div className="bops-modal-overlay" onClick={() => setShowHood(false)}>
          <div className="bops-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bops-modal-head">
              <h2>Under the hood</h2>
              <button className="bops-btn-sm" onClick={() => setShowHood(false)}>✕</button>
            </div>
            {hood?.note && <p className="bops-hood-note">{hood.note}</p>}
            {hood?.error && <div className="bops-state bops-state-error">{hood.error}</div>}
            {hood && !hood.error && (
              <div className="bops-hood">
                <h3>Collections</h3>
                <pre>{JSON.stringify(hood.collections, null, 2)}</pre>
                <h3>Search indexes</h3>
                <pre>{JSON.stringify(hood.indexes, null, 2)}</pre>
                <h3>Retention</h3>
                <pre>{JSON.stringify(hood.retention, null, 2)}</pre>
                <h3>Anomaly rule</h3>
                <pre>{JSON.stringify(hood.rule, null, 2)}</pre>
                <h3>Detection pipeline ($setWindowFields)</h3>
                <pre>{JSON.stringify(hood.pipelines.detection, null, 2)}</pre>
                <h3>Keyword search pipeline ($search)</h3>
                <pre>{JSON.stringify(hood.pipelines.keywordSearch, null, 2)}</pre>
                <h3>Vector search pipeline ($vectorSearch, autoEmbed)</h3>
                <pre>{JSON.stringify(hood.pipelines.vectorSearch, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, alert }: { label: string; value: any; sub?: string; alert?: boolean }) {
  return (
    <div className={`bops-sumcard ${alert ? "alert" : ""}`}>
      <div className="bops-sumcard-label">{label}</div>
      <div className="bops-sumcard-value">{value}</div>
      {sub && <div className="bops-sumcard-sub">{sub}</div>}
    </div>
  );
}
