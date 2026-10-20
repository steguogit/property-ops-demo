"use client";

import { useEffect, useState } from "react";
import { bopsApi, fmtTime } from "@/lib/bops/client";
import { SIGNAL_META, SEVERITY_META } from "./SignalColors";
import { TelemetryChart } from "./TelemetryChart";
import { KnowledgeTab, KnowledgeSelection } from "./KnowledgeTab";

interface Props {
  runId: string;
  token: string;
  assetId: string;
  onClose: () => void;
  onChanged: () => void;
}

const RANGES = [
  { label: "15 min", ms: 15 * 60 * 1000 },
  { label: "30 min", ms: 30 * 60 * 1000 },
  { label: "60 min", ms: 60 * 60 * 1000 },
];

export function DetailPanel({ runId, token, assetId, onClose, onChanged }: Props) {
  const [asset, setAsset] = useState<any>(null);
  const [tel, setTel] = useState<any>(null);
  const [incident, setIncident] = useState<any>(null);
  const [rangeMs, setRangeMs] = useState(RANGES[0].ms);
  const [chartMode, setChartMode] = useState<"raw" | "agg">("raw");
  const [tab, setTab] = useState<"overview" | "knowledge">("overview");
  const [note, setNote] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<KnowledgeSelection[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadAll() {
    try {
      const a = await bopsApi.asset(assetId, runId);
      setAsset(a);
      const enabled: string[] = a.enabledSignals ?? [];
      const signals = a.asset.points
        .filter((p: any) => !p.additive || enabled.includes(p.key))
        .map((p: any) => p.key);
      if (signals.length) {
        const end = Date.now();
        const t = await bopsApi.telemetry({
          runId,
          assetId,
          mode: chartMode,
          startMs: String(end - rangeMs),
          endMs: String(end),
          signals: signals.join(","),
        });
        setTel(t);
      } else {
        setTel({ points: [], signals: [] });
      }
      // incident for this asset (if any)
      const list = await bopsApi.incidents(runId);
      const forAsset = (list.incidents || []).find((i: any) => i.assetId === assetId);
      if (forAsset) {
        const full = await bopsApi.incidents(runId, forAsset.incidentId);
        setIncident(full.incident);
      } else {
        setIncident(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, rangeMs, chartMode, runId]);

  async function doAction(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setErr(null);
    try {
      await bopsApi.incidentAction({ runId, token, incidentId: incident.incidentId, action, ...extra });
      await loadAll();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createWorkOrder() {
    await doAction("create_work_order", {
      note,
      relatedEventIds: selectedEvents,
      knowledgeRefs: selectedDocs,
    });
    setNote("");
  }

  if (!asset)
    return (
      <aside className="bops-detail" aria-label="Asset detail">
        <div className="bops-state">Loading…</div>
      </aside>
    );

  const a = asset.asset;
  const m = asset.measurement;
  const enabled: string[] = asset.enabledSignals ?? [];
  const chartSignals = a.points
    .filter((p: any) => (!p.additive || enabled.includes(p.key)) && SIGNAL_META[p.key])
    .map((p: any) => ({ ...SIGNAL_META[p.key], key: p.key }));

  return (
    <aside className="bops-detail" aria-label={`Detail for ${a.assetId}`}>
      <div className="bops-detail-head">
        <div>
          <h2>{a.name}</h2>
          <div className="bops-detail-sub">
            {a.assetId} · {a.vendor} {a.model} · {a.location.zoneName} ({a.location.level})
          </div>
        </div>
        <button className="bops-btn-sm" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </div>

      <div className="bops-tabs">
        <button className={`bops-pill ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>
          Measurements & evidence
        </button>
        <button className={`bops-pill ${tab === "knowledge" ? "active" : ""}`} onClick={() => setTab("knowledge")}>
          Knowledge
        </button>
      </div>

      {err && <div className="bops-state bops-state-error">{err}</div>}

      {tab === "knowledge" ? (
        <KnowledgeTab
          onAttach={(sel) =>
            setSelectedDocs((prev) => (prev.find((d) => d.docId === sel.docId) ? prev : [...prev, sel]))
          }
          selectedDocIds={selectedDocs.map((d) => d.docId)}
        />
      ) : (
        <>
          {/* Current measurements */}
          <section className="bops-section">
            <h3>Current measurements</h3>
            {m ? (
              <>
                <div className={`bops-dq ${m.stale ? "stale" : "good"}`}>
                  {m.stale ? "⚠ Stale data" : "● Live"} · last update {fmtTime(m.ts)} ({Math.round(m.ageMs / 1000)}s ago)
                </div>
                <div className="bops-measure-grid">
                  {a.points.map((p: any) => {
                    const on = !p.additive || enabled.includes(p.key);
                    const v = m.values[p.key];
                    return (
                      <div className="bops-measure" key={p.key}>
                        <div className="bops-measure-label">{p.label}</div>
                        <div className="bops-measure-val">
                          {!on ? (
                            <span className="bops-unavail">unavailable</span>
                          ) : typeof v === "number" ? (
                            <>
                              {v} <span className="bops-unit">{p.unit}</span>
                            </>
                          ) : (
                            <span className="bops-unavail">—</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="bops-state">No measurements yet for this run.</div>
            )}
          </section>

          {/* Charts */}
          <section className="bops-section">
            <div className="bops-section-head">
              <h3>Recent telemetry</h3>
              <div className="bops-chart-ctrls">
                {RANGES.map((r) => (
                  <button
                    key={r.label}
                    className={`bops-pill-sm ${rangeMs === r.ms ? "active" : ""}`}
                    onClick={() => setRangeMs(r.ms)}
                  >
                    {r.label}
                  </button>
                ))}
                <span className="bops-sep" />
                <button className={`bops-pill-sm ${chartMode === "raw" ? "active" : ""}`} onClick={() => setChartMode("raw")}>
                  Raw
                </button>
                <button className={`bops-pill-sm ${chartMode === "agg" ? "active" : ""}`} onClick={() => setChartMode("agg")}>
                  1-min avg/min/max
                </button>
              </div>
            </div>
            {tel?.points?.length ? (
              chartSignals.map((s: any) => (
                <TelemetryChart
                  key={s.key}
                  points={tel.points}
                  signal={s}
                  mode={chartMode}
                  refLine={
                    incident && s.key === incident.evidence.primarySignal
                      ? { value: incident.evidence.baselineMean, label: "baseline" }
                      : undefined
                  }
                  markTime={
                    incident && s.key === incident.evidence.primarySignal
                      ? incident.evidence.detectionTime
                      : undefined
                  }
                />
              ))
            ) : (
              <div className="bops-state">No telemetry in range.</div>
            )}
            {tel?.queryMs != null && <div className="bops-tiny">Query {tel.queryMs} ms · {chartMode === "agg" ? "$group over $dateTrunc minute" : "bounded find/sort"}</div>}
          </section>

          {/* Specs */}
          <section className="bops-section">
            <h3>Equipment specifications</h3>
            <pre className="bops-spec">{JSON.stringify(a.specs, null, 2)}</pre>
            {a.maintenance && (
              <div className="bops-maint">
                Maintenance: last serviced {a.maintenance.lastServiced ?? "—"}
                {a.maintenance.intervalDays ? ` · every ${a.maintenance.intervalDays}d` : ""}
                {a.maintenance.note ? ` · ${a.maintenance.note}` : ""}
              </div>
            )}
          </section>

          {/* Incident + evidence */}
          {incident && (
            <section className="bops-section bops-incident-sec">
              <h3>
                Incident — {SEVERITY_META[incident.severity]?.icon} {incident.title}
                <span className={`bops-status bops-status-${incident.status}`}>{incident.status}</span>
              </h3>
              {(() => {
                const primary = incident.evidence.primarySignal;
                const cur = m?.values?.[primary];
                const normal =
                  typeof cur === "number" &&
                  cur - incident.evidence.baselineMean < incident.evidence.thresholdDeltaC;
                const isOpen = incident.status === "open" || incident.status === "acknowledged";
                if (normal && isOpen) {
                  return (
                    <div className="bops-recovered-banner">
                      ● Measurements have returned to normal, but this incident is still{" "}
                      <strong>{incident.status}</strong>. Equipment condition and operator workflow are
                      tracked separately — click <strong>Resolve</strong> or <strong>Dismiss</strong> below
                      to close it (the asset card turns green when no incident is open).
                    </div>
                  );
                }
                return null;
              })()}
              {incident.workOrder && (
                <div className="bops-wo-topbanner">
                  <span className="bops-wo-badge">Demo-only — not submitted</span>
                  <strong>Work order {incident.workOrder.workOrderId}</strong> ({incident.workOrder.status})
                  created {fmtTime(incident.workOrder.createdAt)} · see details below ↓
                </div>
              )}
              <div className="bops-evidence">
                <div className="bops-ev-grid">
                  <Ev k="Rule" v={`${incident.evidence.ruleName} (v${incident.evidence.ruleVersion})`} />
                  <Ev k="Detection time" v={fmtTime(incident.evidence.detectionTime)} />
                  <Ev
                    k="Observed"
                    v={`${incident.evidence.observedValue} ${incident.evidence.primaryUnit}`}
                  />
                  <Ev
                    k="Baseline mean"
                    v={`${incident.evidence.baselineMean} ${incident.evidence.primaryUnit} (window ${incident.evidence.baselineWindowSeconds}s)`}
                  />
                  <Ev
                    k="Threshold"
                    v={`Δ ≥ ${incident.evidence.thresholdDeltaC} ${incident.evidence.primaryUnit} (observed Δ ${incident.evidence.deltaOverBaseline})`}
                  />
                  <Ev k="Valid samples" v={String(incident.evidence.validSampleCount)} />
                  <Ev k="Consecutive breaches" v={String(incident.evidence.consecutiveBreaches)} />
                  <Ev
                    k="Telemetry interval"
                    v={`${fmtTime(incident.evidence.telemetryIntervalStart)} → ${fmtTime(incident.evidence.telemetryIntervalEnd)}`}
                  />
                </div>
                <div className="bops-ev-supporting">
                  {incident.evidence.supporting.map((s: any) => (
                    <span key={s.key} className="bops-chip">
                      {s.label}: {Number.isFinite(s.value) ? `${s.value} ${s.unit}` : "—"}
                    </span>
                  ))}
                </div>
              </div>

              {/* Related events — contextual only */}
              <h4>Related events (contextual match — correlation ≠ causation)</h4>
              {incident.relatedEvents.length ? (
                <ul className="bops-related">
                  {incident.relatedEvents.map((r: any) => (
                    <li key={r.eventId}>
                      <label className="bops-check">
                        <input
                          type="checkbox"
                          checked={selectedEvents.includes(r.eventId)}
                          onChange={(e) =>
                            setSelectedEvents((prev) =>
                              e.target.checked ? [...prev, r.eventId] : prev.filter((x) => x !== r.eventId)
                            )
                          }
                        />
                        <span>
                          {r.eventType.replace(/_/g, " ")} · {r.zoneId} · {fmtTime(r.eventTime)} ({r.offsetSeconds >= 0 ? "+" : ""}
                          {r.offsetSeconds}s)
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="bops-state">No contextual events in the correlation window.</div>
              )}

              {/* Actions */}
              <div className="bops-actions">
                <button className="bops-btn-sm" disabled={busy || incident.status !== "open"} onClick={() => doAction("acknowledge")}>
                  Acknowledge
                </button>
                <button className="bops-btn-sm" disabled={busy} onClick={() => doAction("resolve")}>
                  Resolve
                </button>
                <button className="bops-btn-sm" disabled={busy} onClick={() => doAction("dismiss")}>
                  Dismiss
                </button>
              </div>
              <p className="bops-note-dim">
                Acknowledge/resolve change workflow status only — they do not imply the equipment recovered.
              </p>

              {/* Work order */}
              <div className="bops-wo">
                <h4>Create simulated work order</h4>
                <div className="bops-wo-selected">
                  {selectedDocs.length} knowledge doc(s), {selectedEvents.length} event(s) selected as evidence
                  {selectedDocs.length > 0 && (
                    <ul>
                      {selectedDocs.map((d) => (
                        <li key={d.docId}>
                          {d.title} ({d.revision})
                          <button className="bops-x" onClick={() => setSelectedDocs((p) => p.filter((x) => x.docId !== d.docId))}>
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <textarea
                  className="bops-textarea"
                  placeholder="Operator note (your interpretation — kept distinct from the evidence)…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <button className="bops-btn" disabled={busy} onClick={createWorkOrder}>
                  Create work-order draft
                </button>

                {incident.workOrder && (
                  <div className="bops-wo-draft">
                    <div className="bops-wo-badge">Demo-only — not submitted to an external system</div>
                    <div><strong>{incident.workOrder.workOrderId}</strong> · {incident.workOrder.status}</div>
                    <div className="bops-tiny">Created {fmtTime(incident.workOrder.createdAt)}</div>
                    {incident.workOrder.note && <p>Note: {incident.workOrder.note}</p>}
                    <div className="bops-tiny">
                      Evidence snapshot: observed {incident.workOrder.evidenceSnapshot.observedValue}{" "}
                      {incident.workOrder.evidenceSnapshot.primaryUnit}, baseline{" "}
                      {incident.workOrder.evidenceSnapshot.baselineMean}
                    </div>
                    <div className="bops-tiny">
                      Linked: {incident.workOrder.relatedEventIds.length} event(s),{" "}
                      {incident.workOrder.knowledgeRefs.length} knowledge ref(s)
                    </div>
                    {incident.workOrder.knowledgeRefs.length > 0 && (
                      <ul className="bops-tiny">
                        {incident.workOrder.knowledgeRefs.map((k: any) => (
                          <li key={k.docId}>
                            {k.title} ({k.revision}) · {k.source}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* Action history */}
              {incident.actions?.length > 0 && (
                <div className="bops-history">
                  <h4>Operator action history</h4>
                  <ul>
                    {incident.actions.map((act: any, i: number) => (
                      <li key={i}>
                        {fmtTime(act.at)} · {act.action.replace(/_/g, " ")} · {act.by}
                        {act.note ? ` — ${act.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </aside>
  );
}

function Ev({ k, v }: { k: string; v: string }) {
  return (
    <div className="bops-ev">
      <span className="bops-ev-k">{k}</span>
      <span className="bops-ev-v">{v}</span>
    </div>
  );
}
