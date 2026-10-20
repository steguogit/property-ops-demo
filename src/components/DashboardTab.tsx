"use client";

import React, { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useDataset } from "@/lib/dataset-context";

interface Metrics {
  ok?: boolean;
  error?: string;
  corpus?: {
    chunkCount: number;
    documentCount: number;
    aliasCount: number;
    byDocType: Record<string, number>;
    byProperty: Record<string, number>;
    byFileType: Record<string, number>;
  };
  ingestion?: {
    jobCount: number;
    ocrUsed: number;
    ocrNotUsed: number;
    embeddingStatus: Record<string, number>;
    recentUploads: {
      documentId: string;
      title: string;
      sourceFileType: string;
      chunkCount: number;
      ocrUsed: boolean;
      status: string;
      uploadedAt: string;
    }[];
    avgStepMs: { step: string; avgMs: number; count: number }[];
  };
  governance?: {
    reviewStatus: Record<string, number>;
    signatureStatus: Record<string, number>;
    obsoleteCount: number;
    currentCount: number;
    activePolicies: number;
    activeCorrections: number;
  };
  retrieval?: {
    modelCalls: { operation: string; calls: number }[];
    totalCalls: number;
  };
  tokens?: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
    byOperation: { operation: string; tokens: number; calls: number }[];
    byProvider: { provider: string; tokens: number; calls: number }[];
    byModel: { model: string; tokens: number; calls: number }[];
    recent: {
      operation: string;
      provider: string;
      model: string;
      kind: string;
      totalTokens: number;
      createdAt: string;
    }[];
  };
}

const STEP_LABEL: Record<string, string> = {
  extract: "Extract / OCR",
  enrich_aliases: "Alias resolve",
  chunk: "Chunk",
  store_original: "Store original",
  embed: "Embed",
  embed_multimodal: "Embed (multimodal)",
  embed_page_images: "Embed page images",
  embed_image_pixels: "Embed image pixels",
  write: "Write to Atlas",
};

function fmtNum(n: number): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtMs(ms: number): string {
  if (ms == null) return "—";
  if (ms === 0) return "<1 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** A horizontal breakdown bar for `{ key: count }` maps. */
function BreakdownBars({
  data,
  colorVar = "--blue",
}: {
  data: Record<string, number> | { key: string; value: number }[];
  colorVar?: string;
}) {
  const rows = Array.isArray(data)
    ? data
    : Object.entries(data).map(([key, value]) => ({ key, value }));
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="dash-empty">No data yet</div>;
  return (
    <div className="dash-bars">
      {rows.map((r) => (
        <div className="dash-bar-row" key={r.key}>
          <span className="dash-bar-label" title={r.key}>
            {r.key || "—"}
          </span>
          <div className="dash-bar-track">
            <div
              className="dash-bar-fill"
              style={{
                width: `${Math.max((r.value / max) * 100, 4)}%`,
                background: `var(${colorVar})`,
              }}
            />
          </div>
          <span className="dash-bar-value">{fmtNum(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function DashboardTab({
  onNavigate,
}: {
  onNavigate?: (tab: any) => void;
}) {
  const { t } = useI18n();
  const { activeId: datasetId, active: activeDataset } = useDataset();
  const [m, setM] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/metrics?datasetId=${encodeURIComponent(datasetId)}`
      );
      setM(await res.json());
    } catch (e) {
      setM({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  const corpus = m?.corpus;
  const ingestion = m?.ingestion;
  const gov = m?.governance;
  const tokens = m?.tokens;

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div>
          <h2>{t("dash.title")}</h2>
          <p className="sub">
            {t("dash.sub")} ·{" "}
            <b>{activeDataset?.name ?? datasetId}</b>
          </p>
        </div>
        <button className="btn sm" onClick={load} disabled={loading}>
          {loading ? <span className="loading" /> : t("dash.refresh")}
        </button>
      </div>

      {m && m.ok === false && (
        <div className="notice warn">
          {t("dash.error")}: {m.error}
        </div>
      )}

      {/* ---- Top KPI row ---- */}
      <div className="kpi-grid">
        <div className="kpi">
          <span className="kpi-label">{t("dash.kpi.documents")}</span>
          <span className="kpi-value">{fmtNum(corpus?.documentCount ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t("dash.kpi.chunks")}</span>
          <span className="kpi-value">{fmtNum(corpus?.chunkCount ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t("dash.kpi.aliases")}</span>
          <span className="kpi-value">{fmtNum(corpus?.aliasCount ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t("dash.kpi.tokens")}</span>
          <span className="kpi-value accent-purple">
            {fmtNum(tokens?.totalTokens ?? 0)}
          </span>
          <span className="kpi-foot">
            {fmtNum(tokens?.calls ?? 0)} {t("dash.kpi.calls")}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t("dash.kpi.needsReview")}</span>
          <span className="kpi-value accent-amber">
            {fmtNum(
              (gov?.reviewStatus?.unreviewed ?? 0) +
                (gov?.reviewStatus?.needs_correction ?? 0)
            )}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t("dash.kpi.obsolete")}</span>
          <span className="kpi-value">{fmtNum(gov?.obsoleteCount ?? 0)}</span>
          <span className="kpi-foot">
            {fmtNum(gov?.currentCount ?? 0)} {t("dash.kpi.current")}
          </span>
        </div>
      </div>

      <div className="dash-grid">
        {/* ---- Corpus ---- */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>{t("dash.corpus.title")}</h3>
            <span className="dash-card-tag">{t("dash.corpus.tag")}</span>
          </div>
          <div className="dash-subhead">{t("dash.corpus.byType")}</div>
          <BreakdownBars data={corpus?.byDocType ?? {}} colorVar="--green" />
          <div className="dash-subhead">{t("dash.corpus.byProperty")}</div>
          <BreakdownBars data={corpus?.byProperty ?? {}} colorVar="--blue" />
          <div className="dash-subhead">{t("dash.corpus.byFile")}</div>
          <BreakdownBars data={corpus?.byFileType ?? {}} colorVar="--purple" />
        </div>

        {/* ---- Ingestion ---- */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>{t("dash.ingest.title")}</h3>
            <span className="dash-card-tag">
              {fmtNum(ingestion?.jobCount ?? 0)} {t("dash.ingest.jobs")}
            </span>
          </div>
          <div className="dash-pill-row">
            <span className="dash-pill">
              OCR used: <b>{ingestion?.ocrUsed ?? 0}</b>
            </span>
            <span className="dash-pill">
              No OCR: <b>{ingestion?.ocrNotUsed ?? 0}</b>
            </span>
          </div>
          <div className="dash-subhead">{t("dash.ingest.embedStatus")}</div>
          <BreakdownBars
            data={ingestion?.embeddingStatus ?? {}}
            colorVar="--green"
          />
          <div className="dash-subhead">{t("dash.ingest.avgStep")}</div>
          <div className="dash-bars">
            {(ingestion?.avgStepMs ?? []).length === 0 && (
              <div className="dash-empty">No ingestion jobs yet</div>
            )}
            {(ingestion?.avgStepMs ?? []).map((s) => {
              const max = Math.max(
                1,
                ...(ingestion?.avgStepMs ?? []).map((x) => x.avgMs)
              );
              return (
                <div className="dash-bar-row" key={s.step}>
                  <span className="dash-bar-label" title={s.step}>
                    {STEP_LABEL[s.step] ?? s.step}
                  </span>
                  <div className="dash-bar-track">
                    <div
                      className="dash-bar-fill"
                      style={{
                        width: `${Math.max((s.avgMs / max) * 100, 4)}%`,
                        background: "var(--amber)",
                      }}
                    />
                  </div>
                  <span className="dash-bar-value">{fmtMs(s.avgMs)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ---- Governance ---- */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>{t("dash.gov.title")}</h3>
            <span className="dash-card-tag">{t("dash.gov.tag")}</span>
          </div>
          <div className="dash-subhead">{t("dash.gov.review")}</div>
          <BreakdownBars data={gov?.reviewStatus ?? {}} colorVar="--blue" />
          <div className="dash-subhead">{t("dash.gov.signature")}</div>
          <BreakdownBars data={gov?.signatureStatus ?? {}} colorVar="--purple" />
          <div className="dash-pill-row" style={{ marginTop: 12 }}>
            <button
              className="dash-stat-pill"
              onClick={() => onNavigate?.("policies")}
            >
              <b>{gov?.activePolicies ?? 0}</b> {t("dash.gov.policies")}
            </button>
            <button
              className="dash-stat-pill"
              onClick={() => onNavigate?.("corrections")}
            >
              <b>{gov?.activeCorrections ?? 0}</b> {t("dash.gov.corrections")}
            </button>
          </div>
        </div>

        {/* ---- Tokens ---- */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>{t("dash.tokens.title")}</h3>
            <span className="dash-card-tag accent-purple">
              {fmtNum(tokens?.totalTokens ?? 0)} tok
            </span>
          </div>
          <div className="dash-pill-row">
            <span className="dash-pill">
              prompt: <b>{fmtNum(tokens?.promptTokens ?? 0)}</b>
            </span>
            <span className="dash-pill">
              completion: <b>{fmtNum(tokens?.completionTokens ?? 0)}</b>
            </span>
          </div>
          <div className="dash-subhead">{t("dash.tokens.byOperation")}</div>
          <BreakdownBars
            data={(tokens?.byOperation ?? []).map((r) => ({
              key: r.operation,
              value: r.tokens,
            }))}
            colorVar="--purple"
          />
          <div className="dash-subhead">{t("dash.tokens.byProvider")}</div>
          <BreakdownBars
            data={(tokens?.byProvider ?? []).map((r) => ({
              key: r.provider,
              value: r.tokens,
            }))}
            colorVar="--green"
          />
          <div className="dash-subhead">{t("dash.tokens.byModel")}</div>
          <BreakdownBars
            data={(tokens?.byModel ?? []).map((r) => ({
              key: r.model,
              value: r.tokens,
            }))}
            colorVar="--blue"
          />
        </div>

        {/* ---- Recent ingestion ---- */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>{t("dash.recent.title")}</h3>
          </div>
          {(ingestion?.recentUploads ?? []).length === 0 && (
            <div className="dash-empty">No uploads yet</div>
          )}
          <div className="dash-list">
            {(ingestion?.recentUploads ?? []).map((d) => (
              <div className="dash-list-row" key={d.documentId}>
                <div className="dash-list-main">
                  <span className="dash-list-title" title={d.title}>
                    {d.title}
                  </span>
                  <span className="dash-list-meta">
                    {d.sourceFileType} · {d.chunkCount} chunks
                    {d.ocrUsed ? " · OCR" : ""}
                  </span>
                </div>
                <span className={`status-tag ${d.status}`}>{d.status}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Recent model activity ---- */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>{t("dash.activity.title")}</h3>
          </div>
          {(tokens?.recent ?? []).length === 0 && (
            <div className="dash-empty">No model calls recorded yet</div>
          )}
          <div className="dash-list">
            {(tokens?.recent ?? []).map((u, i) => (
              <div className="dash-list-row" key={i}>
                <div className="dash-list-main">
                  <span className="dash-list-title">
                    <span className="badge type">{u.operation}</span> {u.model}
                  </span>
                  <span className="dash-list-meta">
                    {u.provider} · {u.kind} ·{" "}
                    {new Date(u.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <span className="dash-token-count">
                  {fmtNum(u.totalTokens)} tok
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
