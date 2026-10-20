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
import { DashboardTab } from "@/components/DashboardTab";
import { useI18n } from "@/lib/i18n";
// FSI EXPANSION: global industry mode (property/fsi) + presentational config.
import { useIndustry } from "@/lib/industry-context";
// Multi-dataset isolation: active demo dataset for retrieval + uploads.
import { useDataset } from "@/lib/dataset-context";
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
  // Multi-dataset isolation: the active demo dataset scopes all retrieval +
  // uploads. For the two built-in demos we keep the industry chrome in sync.
  const {
    datasets,
    activeId: datasetId,
    setActiveId: setDatasetId,
    createDataset,
  } = useDataset();
  const [creatingDataset, setCreatingDataset] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState("");
  // Optional query IMAGE (Compare tab image-in-search-box). When set, Compare
  // runs image-to-image vector search instead of text search.
  const [queryImage, setQueryImage] = useState<File | null>(null);
  const [queryImageUrl, setQueryImageUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<
    | "dashboard"
    | "compare"
    | "model-compare"
    | "chat"
    | "signatures"
    | "documents"
    | "policies"
    | "corrections"
  >("compare");

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ModeResult[] | null>(null);
  const [modelResults, setModelResults] = useState<ModeResult[] | null>(null);

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
  // "View MongoDB document" dialog — shows the actual chunk document shape.
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docModal, setDocModal] = useState<any | null>(null);
  const [docModalId, setDocModalId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/status?datasetId=${encodeURIComponent(datasetId)}`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [datasetId]);

  // Maintain an object-URL preview for the optional query image.
  useEffect(() => {
    if (!queryImage) {
      setQueryImageUrl(null);
      return;
    }
    const u = URL.createObjectURL(queryImage);
    setQueryImageUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [queryImage]);

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

  // Open the "View MongoDB document" dialog for a chunk (_id = docId#chunkIndex)
  // and fetch its actual stored document from Atlas.
  async function openDocModal(id: string) {
    setDocModalId(id);
    setDocModal(null);
    setDocModalOpen(true);
    try {
      const res = await fetch(`/api/chunk/${encodeURIComponent(id)}`);
      setDocModal(await res.json());
    } catch {
      setDocModal({ error: "Failed to load document" });
    }
  }

  /** Read a File as a base64 data URL (for the image-query search payload). */
  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function runCompare() {
    setLoading(true);
    setResults(null);
    setGenAnswers({});
    setGenLoading({});
    setActiveGenMode(null);
    try {
      // Image query path: image-to-image vector search.
      if (queryImage) {
        const image = await fileToDataUrl(queryImage);
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            image,
            limit: 8,
            datasetId,
          }),
        });
        const data = await res.json();
        setResults(data.results ?? []);
        return;
      }

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
          datasetId, // multi-dataset isolation
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
          datasetId, // multi-dataset isolation
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

  // Switch the active demo dataset. For the two built-in datasets we also keep
  // the industry chrome (title/tagline/placeholder) in sync.
  function handleDatasetChange(id: string) {
    setDatasetId(id);
    if (id === "property" || id === "fsi") setMode(id);
  }

  // Create a brand-new demo dataset and make it active. Everything uploaded
  // next lands in this demo, isolated from all other datasets.
  async function handleNewDemo() {
    const name = window.prompt(
      "Name this new demo dataset (e.g. \"HLD Demo\"). Everything you upload while it is active stays isolated to it."
    );
    if (!name || !name.trim()) return;
    setCreatingDataset(true);
    try {
      await createDataset(name.trim());
      // New datasets are not built-in, so they use the generic property chrome.
      setMode("property");
    } finally {
      setCreatingDataset(false);
    }
  }

  function onRun() {
    if (tab === "compare") runCompare();
    else if (tab === "model-compare") runModelCompare();
  }

  const showQueryBar =
    tab === "compare" || tab === "model-compare";

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
        <div className="brand">
          <div className="leaf">{mode === "fsi" ? "FSI" : "PM"}</div>
          <div>
            {/* FSI EXPANSION: title/tagline now driven by industry mode. */}
            <h1>{chrome.title}</h1>
            <p>{chrome.tagline}</p>
          </div>
        </div>
        <div className="status-pills">
          {/* Multi-dataset isolation: active demo switcher + New demo. */}
          <select
            className="pill"
            value={datasetId}
            onChange={(e) => handleDatasetChange(e.target.value)}
            title="Active demo dataset — retrieval and uploads are scoped to this"
          >
            {datasets.map((d) => (
              <option key={d.datasetId} value={d.datasetId}>
                {d.name}
                {d.documentCount != null ? ` (${d.documentCount})` : ""}
              </option>
            ))}
          </select>
          <button
            className="pill"
            onClick={handleNewDemo}
            disabled={creatingDataset}
            title="Create a new isolated demo dataset and switch to it"
          >
            {creatingDataset ? "…" : "+ New demo"}
          </button>
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
        </div>

        {/* Compact single-line MongoDB-features strip, integrated in the
            header. Horizontally scrollable so it never wraps to a second row. */}
        <div className="feature-bar">
          <span className="label">{t("features.label")}</span>
          <div className="feature-tags">
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
          </div>
          <button className="schema-link" onClick={openSchema}>
            {t("features.showSchema")}
          </button>
        </div>
      </header>

      <div className="message">
        <b>{t("intro.bold")}</b> {t("intro.rest")}
      </div>

      {showQueryBar && (
        <div className="querybar">
          <div className="query-row">
            <input
              className="query-input"
              value={query}
              placeholder={
                queryImage
                  ? t("query.imageAttached")
                  : chrome.searchPlaceholder
              }
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onRun()}
              disabled={!!queryImage}
            />
            {/* Google-style search-by-image icon (Compare tab only). */}
            {tab === "compare" && (
              <>
                <input
                  id="query-image-input"
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    if (f) {
                      setQueryImage(f);
                      setResults(null);
                    }
                    e.currentTarget.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn query-image-btn"
                  title={t("query.searchByImage")}
                  onClick={() =>
                    document.getElementById("query-image-input")?.click()
                  }
                >
                  {/* simple camera glyph */}
                  <span aria-hidden>📷</span>
                </button>
              </>
            )}
            <button
              className="btn primary"
              onClick={onRun}
              disabled={loading}
            >
              {loading ? (
                <span className="loading" />
              ) : (
                t("query.compare")
              )}
            </button>
          </div>

          {/* Attached query-image chip with preview + remove. */}
          {tab === "compare" && queryImage && (
            <div className="query-image-chip">
              {queryImageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={queryImageUrl}
                  alt="query"
                  className="query-image-thumb"
                />
              )}
              <span className="query-image-name">
                {t("query.imageMode")}: {queryImage.name}
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setQueryImage(null);
                  setResults(null);
                }}
              >
                {t("query.removeImage")}
              </button>
            </div>
          )}

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
          className={`tab ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => setTab("dashboard")}
        >
          {t("tab.dashboard")}
        </div>
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

      {tab === "dashboard" && <DashboardTab onNavigate={setTab} />}
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
                      onViewDoc={openDocModal}
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
                      onViewDoc={openDocModal}
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

      {/* ---- Actual MongoDB document (chunk) modal ---- */}
      <Modal
        open={docModalOpen}
        onClose={() => setDocModalOpen(false)}
        title={t("docModal.title")}
        subtitle={t("docModal.subtitle", {
          collection: docModal?.collection ?? status?.collection ?? "chunks",
        })}
      >
        {!docModal && <div className="empty">{t("docModal.loading")}</div>}
        {docModal?.error && <div className="err">{docModal.error}</div>}
        {docModal && !docModal.error && (
          <div className="explain-section">
            <div className="schema-meta" style={{ marginBottom: 8 }}>
              <span className="badge type">db: {docModal.database}</span>
              <span className="badge">collection: {docModal.collection}</span>
              {docModalId && <span className="badge prop">_id: {docModalId}</span>}
            </div>
            <div className="stage-coll">
              {t("docModal.meta", {
                collection: docModal.collection,
                id: docModalId ?? "",
              })}
            </div>
            <CodeBlock value={docModal.document} />
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
