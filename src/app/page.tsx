"use client";

import { useEffect, useState } from "react";
import { ResultCard, Hit } from "@/components/ResultCard";
import { Modal, CodeBlock } from "@/components/Modal";
import { DocumentsTab } from "@/components/DocumentsTab";
import { CorrectionsTab } from "@/components/CorrectionsTab";
import { PoliciesTab } from "@/components/PoliciesTab";
import { FilePreviewDialog, PreviewTarget } from "@/components/FilePreview";
import { ChatTab } from "@/components/ChatTab";
import { SignaturesTab } from "@/components/SignaturesTab";
import { useI18n } from "@/lib/i18n";
// FSI EXPANSION: global industry mode (property/fsi) + presentational config.
import { useIndustry } from "@/lib/industry-context";
import { INDUSTRY_CONFIG, INDUSTRY_MODES } from "@/lib/industry";
import { renderAnswer } from "@/lib/renderAnswer";

interface MongoFeature {
  name: string;
  detail: string;
}
interface ExplainStage {
  label: string;
  collection: string;
  pipeline: unknown[];
}
interface ModeExplain {
  mode: string;
  title: string;
  features: MongoFeature[];
  stages: ExplainStage[];
  notes?: string;
}

interface AppliedCorrection {
  type: string;
  summary: string;
}
interface AppliedCorrections {
  applied?: AppliedCorrection[];
}
interface ModeResult {
  mode:
    | "vector"
    | "hybrid"
    | "rerank"
    | "vector-primary"
    | "vector-multimodal";
  ms: number;
  hits: Hit[];
  explain?: ModeExplain;
  models?: { role: string; name: string }[];
  appliedCorrections?: AppliedCorrections | null;
  expandedAliases?: string[];
  matchedProperties?: string[];
  error: string | null;
}

interface RagResponse {
  answer: string;
  mode: string;
  llmUsed: boolean;
  sources: Hit[];
  explain?: ModeExplain;
  models?: { role: string; name: string }[];
  appliedCorrections?: AppliedCorrections | null;
  expandedAliases?: string[];
}

interface Status {
  db: string;
  collection: string;
  chunkCount: number;
  mongoConnected: boolean;
  voyageConfigured: boolean;
  llmConfigured: boolean;
  embeddingStrategy: string;
  embedModel: string;
  rerankModel: string;
  llmProvider?: string;
  llmModel?: string;
  mongoError?: string;
  documentCount?: number;
  correctionCount?: number;
  aliasCount?: number;
}

const SAMPLES = [
  { n: 1, label: "Alias resolution", q: "Is YOHO Mall the same property as 形點?" },
  {
    n: 2,
    label: "SOP retrieval",
    q: "Find the overnight contractor access procedure for YOHO Mall fitting-out works",
  },
  {
    n: 3,
    label: "Incident escalation",
    q: "What is the escalation process for water leakage at Grand YOHO?",
  },
  { n: 4, label: "Bilingual", q: "Find HVAC complaint handling for 環球貿易廣場" },
  {
    n: 5,
    label: "Entity linkage",
    q: "Who is Peter Chan linked to in duty roster records?",
  },
  {
    n: 6,
    label: "Grounded summary",
    q: "Summarize the after-hours handling process for urgent maintenance at Grand YOHO and cite the relevant SOP and contact records",
  },
  {
    n: 7,
    label: "Versioned O&M",
    q: "What is the current chiller plant shutdown procedure for ICC?",
  },
  {
    n: 8,
    label: "Floor-plan change",
    q: "Did the fire / 消防 layout change when 6F was reconfigured to 8F?",
  },
  {
    n: 9,
    label: "Historical name",
    q: "Records for the property formerly known as a different name across years",
  },
];

// Compare columns keyed to i18n dictionary entries (resolved at render time).
const MODE_META = {
  vector: { key: "mode.vector", dot: "vector" },
  hybrid: { key: "mode.hybrid", dot: "hybrid" },
  rerank: { key: "mode.rerank", dot: "rerank" },
} as const;

// Model-comparison columns: same vector search, different embedding model.
const MODEL_META = {
  "vector-primary": { key: "modelcmp.primary", dot: "vector" },
  "vector-multimodal": { key: "modelcmp.mm", dot: "hybrid" },
} as const;

const MODEL_MODES = ["vector-primary", "vector-multimodal"] as const;

export default function Home() {
  const { t, lang, setLang } = useI18n();
  // FSI EXPANSION: active dataset mode + resolved chrome (title/tagline/etc).
  const { mode, setMode, chrome } = useIndustry();
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState(SAMPLES[0].q);
  const [tab, setTab] = useState<
    | "compare"
    | "model-compare"
    | "rag"
    | "chat"
    | "signatures"
    | "documents"
    | "policies"
    | "corrections"
  >("compare");

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ModeResult[] | null>(null);
  const [modelResults, setModelResults] = useState<ModeResult[] | null>(null);

  const [ragLoading, setRagLoading] = useState(false);
  const [rag, setRag] = useState<RagResponse | null>(null);

  // "Generate answer from these results" — per-compare-column grounded answers,
  // reusing already-retrieved candidates (no re-retrieval).
  const [genAnswers, setGenAnswers] = useState<
    Record<string, RagResponse | null>
  >({});
  const [genLoading, setGenLoading] = useState<Record<string, boolean>>({});
  // Which mode's generated answer the fixed top panel currently shows.
  const [activeGenMode, setActiveGenMode] = useState<string | null>(null);

  const [vectorWeight, setVectorWeight] = useState(0.5);
  const [includeObsolete, setIncludeObsolete] = useState(false);
  const [applyCorrections, setApplyCorrections] = useState(true);
  const [expandAliases, setExpandAliases] = useState(true);

  // Modal state
  const [explainModal, setExplainModal] = useState<ModeExplain | null>(null);
  const [schema, setSchema] = useState<any | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(
    null
  );

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function openSchema() {
    setSchemaOpen(true);
    if (!schema) {
      try {
        const res = await fetch("/api/schema");
        setSchema(await res.json());
      } catch {
        setSchema({ error: "Failed to load schema" });
      }
    }
  }

  async function runCompare() {
    setLoading(true);
    setResults(null);
    setGenAnswers({});
    setGenLoading({});
    setActiveGenMode(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          limit: 8,
          vectorWeight,
          lexicalWeight: 1 - vectorWeight,
          includeObsolete,
          applyCorrections,
          expandAliases,
          metadataType: mode, // FSI EXPANSION: dataset isolation
        }),
      });
      const data = await res.json();
      setResults(data.results ?? []);
    } catch (e) {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function runModelCompare() {
    setLoading(true);
    setModelResults(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          limit: 8,
          modes: MODEL_MODES,
          includeObsolete,
          applyCorrections,
          expandAliases,
          metadataType: mode, // FSI EXPANSION: dataset isolation
        }),
      });
      const data = await res.json();
      setModelResults(data.results ?? []);
    } catch (e) {
      setModelResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function runRag() {
    setRagLoading(true);
    setRag(null);
    try {
      const res = await fetch("/api/rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 6, includeObsolete, metadataType: mode }),
      });
      const data = await res.json();
      setRag(data);
    } catch (e) {
      setRag(null);
    } finally {
      setRagLoading(false);
    }
  }

  // Generate a grounded answer directly from a compare column's candidates,
  // without re-running retrieval.
  async function generateFrom(r: ModeResult) {
    const key = r.mode;
    setActiveGenMode(key);
    setGenLoading((s) => ({ ...s, [key]: true }));
    setGenAnswers((s) => ({ ...s, [key]: null }));
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          mode: r.mode,
          hits: r.hits.map((h) => ({
            docId: h.docId,
            chunkIndex: h.chunkIndex,
          })),
        }),
      });
      const data = await res.json();
      setGenAnswers((s) => ({ ...s, [key]: data }));
    } catch (e) {
      setGenAnswers((s) => ({
        ...s,
        [key]: { answer: (e as Error).message } as RagResponse,
      }));
    } finally {
      setGenLoading((s) => ({ ...s, [key]: false }));
    }
  }

  function onRun() {
    if (tab === "compare") runCompare();
    else if (tab === "model-compare") runModelCompare();
    else if (tab === "rag") runRag();
  }

  const showQueryBar =
    tab === "compare" || tab === "model-compare" || tab === "rag";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="leaf">{mode === "fsi" ? "FSI" : "PM"}</div>
          <div>
            {/* FSI EXPANSION: title/tagline now driven by industry mode. */}
            <h1>{chrome.title}</h1>
            <p>{chrome.tagline}</p>
          </div>
        </div>
        <div className="status-pills">
          {/* FSI EXPANSION: global dataset mode switcher. */}
          <select
            className="pill"
            value={mode}
            onChange={(e) =>
              setMode(e.target.value === "fsi" ? "fsi" : "property")
            }
            title="Dataset mode"
          >
            {INDUSTRY_MODES.map((m) => (
              <option key={m} value={m}>
                {INDUSTRY_CONFIG[m][lang === "zh" ? "zh" : "en"].switchLabel}
              </option>
            ))}
          </select>
          <button
            className="pill lang-toggle"
            onClick={() => setLang(lang === "en" ? "zh" : "en")}
            title={t("header.langToggleTitle")}
          >
            {t("header.langToggle")}
          </button>
          <span className={`pill ${status?.mongoConnected ? "ok" : "bad"}`}>
            {status?.mongoConnected
              ? t("pill.atlasChunks", { n: status.chunkCount })
              : t("pill.atlasDisconnected")}
          </span>
          {status?.mongoConnected && status.documentCount != null && (
            <span className="pill ok">
              {t("pill.docs", { n: status.documentCount })}
            </span>
          )}
          {status?.mongoConnected && !!status.correctionCount && (
            <span className="pill warn">
              {t("pill.corrections", { n: status.correctionCount })}
            </span>
          )}
          {status && (
            <span className="pill ok">
              {t("pill.embed", { model: status.embedModel })}
            </span>
          )}
          <span className={`pill ${status?.voyageConfigured ? "ok" : "warn"}`}>
            {status?.voyageConfigured
              ? t("pill.rerank", { model: status.rerankModel })
              : t("pill.rerankOff")}
          </span>
          <span className={`pill ${status?.llmConfigured ? "ok" : "warn"}`}>
            {status?.llmConfigured
              ? t("pill.rag", { model: status.llmModel ?? "" })
              : t("pill.ragExtractive")}
          </span>
        </div>
      </header>

      <div className="message">
        <b>{t("intro.bold")}</b> {t("intro.rest")}
      </div>

      <div className="feature-bar">
        <span className="label">{t("features.label")}</span>
        {[
          "features.vectorSearch",
          "features.atlasSearch",
          "features.rankFusion",
          status?.embeddingStrategy === "atlas"
            ? "features.autoEmbed"
            : "features.voyageEmbed",
          "features.reranker",
          "features.ingestion",
          "features.versionFilters",
          "features.corrections",
          "features.aggregation",
        ].map((f) => (
          <span className="feature-tag" key={f}>
            <span className="ico" />
            {t(f)}
          </span>
        ))}
        <span className="spacer" />
        <button className="schema-link" onClick={openSchema}>
          {t("features.showSchema")}
        </button>
      </div>

      {showQueryBar && (
        <div className="querybar">
          <div className="query-row">
            <input
              className="query-input"
              value={query}
              placeholder={chrome.searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onRun()}
            />
            <button
              className="btn primary"
              onClick={onRun}
              disabled={loading || ragLoading}
            >
              {loading || ragLoading ? (
                <span className="loading" />
              ) : tab === "compare" || tab === "model-compare" ? (
                t("query.compare")
              ) : (
                t("query.answer")
              )}
            </button>
          </div>

          {tab === "compare" && (
            <div className="controls">
              <label>
                {t("query.hybridWeighting")}{" "}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={vectorWeight}
                  onChange={(e) => setVectorWeight(parseFloat(e.target.value))}
                />{" "}
                {t("query.vector")}
              </label>
              <span>
                {t("query.weights", {
                  lex: (1 - vectorWeight).toFixed(1),
                  vec: vectorWeight.toFixed(1),
                })}
              </span>
            </div>
          )}

          <div className="controls search-toggles">
            <label title={t("query.includeObsoleteTitle")}>
              <input
                type="checkbox"
                checked={includeObsolete}
                onChange={(e) => setIncludeObsolete(e.target.checked)}
              />
              {t("query.includeObsolete")}
            </label>
            <label title={t("query.applyCorrectionsTitle")}>
              <input
                type="checkbox"
                checked={applyCorrections}
                onChange={(e) => setApplyCorrections(e.target.checked)}
              />
              {t("query.applyCorrections")}
            </label>
            <label title={t("query.aliasExpansionTitle")}>
              <input
                type="checkbox"
                checked={expandAliases}
                onChange={(e) => setExpandAliases(e.target.checked)}
              />
              {t("query.aliasExpansion")}
            </label>
          </div>

          <div className="samples">
            {SAMPLES.map((s) => (
              <button
                key={s.n}
                className="chip"
                onClick={() => setQuery(s.q)}
                title={s.q}
              >
                <span className="qnum">Q{s.n}</span>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="tabs">
        <div
          className={`tab ${tab === "compare" ? "active" : ""}`}
          onClick={() => setTab("compare")}
        >
          {t("tab.compare")}
        </div>
        <div
          className={`tab ${tab === "model-compare" ? "active" : ""}`}
          onClick={() => setTab("model-compare")}
        >
          {t("tab.modelCompare")}
        </div>
        <div
          className={`tab ${tab === "rag" ? "active" : ""}`}
          onClick={() => setTab("rag")}
        >
          {t("tab.rag")}
        </div>
        <div
          className={`tab ${tab === "chat" ? "active" : ""}`}
          onClick={() => setTab("chat")}
        >
          {t("tab.chat")}
        </div>
        <div
          className={`tab ${tab === "signatures" ? "active" : ""}`}
          onClick={() => setTab("signatures")}
        >
          {t("tab.signatures")}
        </div>
        <div
          className={`tab ${tab === "documents" ? "active" : ""}`}
          onClick={() => setTab("documents")}
        >
          {t("tab.documents")}
        </div>
        <div
          className={`tab ${tab === "policies" ? "active" : ""}`}
          onClick={() => setTab("policies")}
        >
          {t("tab.policies")}
        </div>
        <div
          className={`tab ${tab === "corrections" ? "active" : ""}`}
          onClick={() => setTab("corrections")}
        >
          {t("tab.corrections")}
        </div>
      </div>

      {tab === "chat" && <ChatTab />}
      {tab === "signatures" && <SignaturesTab />}
      {tab === "documents" && <DocumentsTab />}
      {tab === "policies" && <PoliciesTab lastQuery={query} />}
      {tab === "corrections" && <CorrectionsTab lastQuery={query} />}

      {tab === "compare" && results && (() => {
        const first = results[0];
        const aliases = first?.expandedAliases ?? [];
        const corr = first?.appliedCorrections?.applied ?? [];
        if (!aliases.length && !corr.length) return null;
        return (
          <div className="notice info" style={{ marginBottom: 12 }}>
            {aliases.length > 0 && (
              <div>
                <b>{t("compare.aliasExpansion")}</b>{" "}
                {t("compare.aliasEnriched")} {aliases.join(", ")}
              </div>
            )}
            {corr.length > 0 && (
              <div>
                <b>{t("compare.correctionsApplied")}</b>{" "}
                {corr.map((c) => c.summary).join(" · ")}
              </div>
            )}
          </div>
        );
      })()}

      {tab === "compare" &&
        activeGenMode &&
        (genLoading[activeGenMode] || genAnswers[activeGenMode]) && (
          <div className="gen-panel">
            <div className="gen-panel-head">
              <div className="gen-panel-titles">
                <h3>
                  {t("compare.answerFrom", {
                    mode: t(`${MODE_META[activeGenMode as keyof typeof MODE_META].key}.name`),
                  })}
                </h3>
                {/* If more than one column was generated, let the user switch. */}
                {(["vector", "hybrid", "rerank"] as const).filter(
                  (m) => genAnswers[m]
                ).length > 1 && (
                  <div className="gen-switcher">
                    {(["vector", "hybrid", "rerank"] as const)
                      .filter((m) => genAnswers[m])
                      .map((m) => (
                        <button
                          key={m}
                          className={`mini-btn ${
                            activeGenMode === m ? "active" : ""
                          }`}
                          onClick={() => setActiveGenMode(m)}
                        >
                          {t(`${MODE_META[m].key}.name`)}
                        </button>
                      ))}
                  </div>
                )}
              </div>
              <div className="gen-panel-actions">
                {genAnswers[activeGenMode] && (
                  <>
                    <span className="badge">
                      {genAnswers[activeGenMode]!.llmUsed
                        ? t("rag.llm")
                        : t("rag.extractive")}
                    </span>
                    <span className="badge type">{t("compare.reused")}</span>
                  </>
                )}
                <button
                  className="modal-close"
                  onClick={() => setActiveGenMode(null)}
                  aria-label={t("common.close")}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="gen-panel-body">
              {genLoading[activeGenMode] && !genAnswers[activeGenMode] ? (
                <div className="answer">
                  <span className="loading" /> {t("compare.generating")}
                </div>
              ) : (
                <div className="text">
                  {renderAnswer(genAnswers[activeGenMode]!.answer)}
                </div>
              )}
            </div>
          </div>
        )}

      {tab === "compare" && (
        <div className="compare-grid">
          {(["vector", "hybrid", "rerank"] as const).map((mode) => {
            const r = results?.find((x) => x.mode === mode);
            const meta = MODE_META[mode];
            return (
              <div className="mode-col" key={mode}>
                <div className="mode-head">
                  <span className="name">
                    <span className={`dot ${meta.dot}`} />
                    {t(`${meta.key}.name`)}
                  </span>
                  <span className="mini-btns">
                    {r && (
                      <span className="meta">{t("common.ms", { n: r.ms })}</span>
                    )}
                    {r?.explain && (
                      <button
                        className="mini-btn"
                        onClick={() => setExplainModal(r.explain!)}
                        title={t("common.showQuery")}
                      >
                        {t("common.showQuery")}
                      </button>
                    )}
                  </span>
                </div>
                <div className="mode-sub">{t(`${meta.key}.sub`)}</div>
                {!!r?.models?.length && (
                  <div className="mode-models">
                    <span className="mode-models-label">
                      {t("common.modelsUsed")}
                    </span>
                    {r.models.map((mo, j) => (
                      <span className="model-chip" key={j}>
                        <span className="model-role">{mo.role}</span>
                        {mo.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mode-body">
                  {!results && !loading && (
                    <div className="empty">{t("common.runToCompare")}</div>
                  )}
                  {loading && <div className="empty">{t("common.retrieving")}</div>}
                  {r?.error && <div className="err">{r.error}</div>}
                  {r && !r.error && r.hits.length === 0 && (
                    <div className="empty">{t("common.noResults")}</div>
                  )}
                  {r && !r.error && r.hits.length > 0 && (
                    <button
                      className="btn sm gen-btn"
                      onClick={() => generateFrom(r)}
                      disabled={!!genLoading[mode]}
                      title={t("compare.generateTitle")}
                    >
                      {genLoading[mode] ? (
                        <>
                          <span className="loading" /> {t("compare.generating")}
                        </>
                      ) : (
                        t("compare.generateAnswer")
                      )}
                    </button>
                  )}

                  {r?.hits.map((h) => (
                    <ResultCard
                      hit={h}
                      onPreview={setPreviewTarget}
                      query={query}
                      key={`${h.docId}#${h.chunkIndex}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "model-compare" && (
        <div className="notice info" style={{ marginBottom: 12 }}>
          {t("modelcmp.notice", { primary: status?.embedModel ?? "voyage-4" })}
        </div>
      )}

      {tab === "model-compare" && (
        <div className="compare-grid model-compare-grid">
          {MODEL_MODES.map((mode) => {
            const r = modelResults?.find((x) => x.mode === mode);
            const meta = MODEL_META[mode];
            return (
              <div className="mode-col" key={mode}>
                <div className="mode-head">
                  <span className="name">
                    <span className={`dot ${meta.dot}`} />
                    {t(`${meta.key}.name`)}
                  </span>
                  <span className="mini-btns">
                    {r && (
                      <span className="meta">{t("common.ms", { n: r.ms })}</span>
                    )}
                    {r?.explain && (
                      <button
                        className="mini-btn"
                        onClick={() => setExplainModal(r.explain!)}
                        title={t("common.showQuery")}
                      >
                        {t("common.showQuery")}
                      </button>
                    )}
                  </span>
                </div>
                <div className="mode-sub">{t(`${meta.key}.sub`)}</div>
                {!!r?.models?.length && (
                  <div className="mode-models">
                    <span className="mode-models-label">
                      {t("common.modelsUsed")}
                    </span>
                    {r.models.map((mo, j) => (
                      <span className="model-chip" key={j}>
                        <span className="model-role">{mo.role}</span>
                        {mo.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mode-body">
                  {!modelResults && !loading && (
                    <div className="empty">{t("modelcmp.runToCompare")}</div>
                  )}
                  {loading && <div className="empty">{t("common.retrieving")}</div>}
                  {r?.error && <div className="err">{r.error}</div>}
                  {r && !r.error && r.hits.length === 0 && (
                    <div className="empty">{t("common.noResults")}</div>
                  )}
                  {r?.hits.map((h) => (
                    <ResultCard
                      hit={h}
                      onPreview={setPreviewTarget}
                      query={query}
                      key={`${h.docId}#${h.chunkIndex}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "rag" && (
        <div className="rag-wrap">
          {!rag && !ragLoading && (
            <div className="empty">{t("rag.empty")}</div>
          )}
          {ragLoading && (
            <div className="answer">
              <span className="loading" /> {t("rag.generating")}
            </div>
          )}
          {rag && (
            <>
              <div className="answer">
                <h3>
                  {t("rag.groundedAnswer")}
                  <span className="badge type">
                    {t("rag.contextVia", { mode: rag.mode })}
                  </span>
                  <span className="badge">
                    {rag.llmUsed ? t("rag.llm") : t("rag.extractive")}
                  </span>
                  {rag.explain && (
                    <button
                      className="mini-btn"
                      style={{ marginLeft: "auto" }}
                      onClick={() => setExplainModal(rag.explain!)}
                    >
                      {t("rag.showPipeline")}
                    </button>
                  )}
                </h3>
                {!!rag.models?.length && (
                  <div className="mode-models">
                    <span className="mode-models-label">
                      {t("common.modelsUsed")}
                    </span>
                    {rag.models.map((mo, j) => (
                      <span className="model-chip" key={j}>
                        <span className="model-role">{mo.role}</span>
                        {mo.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="text">{renderAnswer(rag.answer)}</div>
                {(rag.expandedAliases?.length ||
                  rag.appliedCorrections?.applied?.length) && (
                  <div
                    className="notice info"
                    style={{ marginTop: 12, marginBottom: 0 }}
                  >
                    {rag.expandedAliases?.length ? (
                      <div>
                        <b>{t("rag.aliasExpansion")}</b>{" "}
                        {rag.expandedAliases.join(", ")}
                      </div>
                    ) : null}
                    {rag.appliedCorrections?.applied?.length ? (
                      <div>
                        <b>{t("rag.correctionsApplied")}</b>{" "}
                        {rag.appliedCorrections.applied
                          .map((c) => c.summary)
                          .join(" · ")}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="sources-title">
                {t("rag.sourceEvidence", { n: rag.sources.length })}
                <button
                  className="mini-btn"
                  style={{ marginLeft: 10 }}
                  onClick={() => setTab("corrections")}
                  title={t("rag.correctInterpretationTitle")}
                >
                  {t("rag.correctInterpretation")}
                </button>
              </div>
              <div className="compare-grid">
                {rag.sources.map((h) => (
                  <ResultCard
                    hit={h}
                    onPreview={setPreviewTarget}
                      query={query}
                    key={`${h.docId}#${h.chunkIndex}`}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="footnote">{t("footnote")}</div>

      {/* ---- Explain (query + features) modal ---- */}
      <Modal
        open={!!explainModal}
        onClose={() => setExplainModal(null)}
        title={
          explainModal
            ? t("modal.explainHowItWorks", { title: explainModal.title })
            : ""
        }
        subtitle={t("modal.explainSubtitle")}
      >
        {explainModal && (
          <>
            <div className="explain-section">
              <h3>{t("modal.featuresUsed")}</h3>
              <div className="feature-list">
                {explainModal.features.map((f) => (
                  <div className="feature-item" key={f.name}>
                    <div className="fname">{f.name}</div>
                    <div className="fdetail">{f.detail}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="explain-section">
              <h3>{t("modal.queryExecuted")}</h3>
              {explainModal.stages.map((s, i) => (
                <div key={i}>
                  <div className="stage-label">{s.label}</div>
                  <div className="stage-coll">
                    db.{s.collection.split(".").pop()}.aggregate( … ) ·{" "}
                    {s.collection}
                  </div>
                  <CodeBlock value={s.pipeline} />
                </div>
              ))}
            </div>

            {explainModal.notes && (
              <div className="explain-section">
                <h3>{t("modal.notes")}</h3>
                <div className="explain-note">{explainModal.notes}</div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* ---- Schema modal ---- */}
      <Modal
        open={schemaOpen}
        onClose={() => setSchemaOpen(false)}
        title={t("modal.schemaTitle2")}
        subtitle={t("modal.schemaSub2")}
      >
        {!schema && <div className="empty">{t("modal.loadingSchema")}</div>}
        {schema?.error && <div className="err">{schema.error}</div>}
        {schema && !schema.error && (
          <div className="schema-grid">
            <div className="schema-section">
              <div className="schema-meta">
                <span className="badge type">db: {schema.database}</span>
                <span className="badge">collection: {schema.collection}</span>
                <span className="badge prop">
                  {schema.documentCount} chunks
                </span>
                <span className="badge">embed: {schema.embeddingStrategy}</span>
              </div>
            </div>

            {schema.collections && (
              <div className="explain-section">
                <h3>{t("modal.collections")}</h3>
                <div className="feature-list">
                  {Object.entries(schema.collections).map(
                    ([k, v]: [string, any]) => (
                      <div className="feature-item" key={k}>
                        <div className="fname">{k}</div>
                        <div className="fdetail">{v}</div>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}

            <div className="explain-section">
              <h3>{t("modal.chunkSchema")}</h3>
              <CodeBlock value={schema.jsonSchema} />
            </div>

            <div className="explain-section">
              <h3>{t("modal.indexDefs")}</h3>
              <div className="stage-label">
                {t("modal.vectorIndex", {
                  name: schema.indexes?.vectorIndex?.name ?? "",
                })}
              </div>
              <CodeBlock value={schema.indexes?.vectorIndex} />
              <div className="stage-label">
                {t("modal.lexicalIndex", {
                  name: schema.indexes?.searchIndex?.name ?? "",
                })}
              </div>
              <CodeBlock value={schema.indexes?.searchIndex} />
            </div>

            <div className="explain-section">
              <h3>{t("modal.liveSample")}</h3>
              <CodeBlock value={schema.sample} />
            </div>
          </div>
        )}
      </Modal>

      {/* ---- Fullscreen file preview dialog ---- */}
      <FilePreviewDialog
        open={!!previewTarget}
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
}
