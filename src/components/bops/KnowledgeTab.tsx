"use client";

import { useState } from "react";
import { bopsApi } from "@/lib/bops/client";

const PRESET_KEYWORD = "chiller vibration";
const PRESET_SEMANTIC =
  "Cooling output is worsening while the machine shakes more and draws additional electricity.";

export interface KnowledgeSelection {
  docId: string;
  title: string;
  revision?: string;
  source?: string;
}

export function KnowledgeTab({
  onAttach,
  selectedDocIds,
}: {
  onAttach?: (sel: KnowledgeSelection) => void;
  selectedDocIds?: string[];
}) {
  const [mode, setMode] = useState<"keyword" | "semantic">("keyword");
  const [query, setQuery] = useState(PRESET_KEYWORD);
  const [equipmentType, setEquipmentType] = useState("");
  const [docType, setDocType] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [origDoc, setOrigDoc] = useState<any>(null);

  async function run(overrides?: { equipmentType?: string; docType?: string }) {
    const eq = overrides?.equipmentType ?? equipmentType;
    const dt = overrides?.docType ?? docType;
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = { mode, q: query };
      if (eq) params.equipmentType = eq;
      if (dt) params.docType = dt;
      const r = await bopsApi.knowledge(params);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  /** Toggle a facet value and immediately re-run so counts/results reflect it. */
  function applyFacet(field: "equipmentType" | "docType", value: string) {
    if (field === "equipmentType") {
      const next = equipmentType === value ? "" : value;
      setEquipmentType(next);
      void run({ equipmentType: next });
    } else {
      const next = docType === value ? "" : value;
      setDocType(next);
      void run({ docType: next });
    }
  }

  async function viewOriginal(docId: string) {
    try {
      const r = await bopsApi.knowledgeDoc(docId);
      setOrigDoc(r);
    } catch (e) {
      setOrigDoc({ error: (e as Error).message });
    }
  }

  function switchMode(m: "keyword" | "semantic") {
    setMode(m);
    setQuery(m === "keyword" ? PRESET_KEYWORD : PRESET_SEMANTIC);
    setResult(null);
  }

  return (
    <div className="bops-knowledge">
      <div className="bops-kw-modes" role="tablist" aria-label="Knowledge search mode">
        <button
          role="tab"
          aria-selected={mode === "keyword"}
          className={`bops-pill ${mode === "keyword" ? "active" : ""}`}
          onClick={() => switchMode("keyword")}
        >
          Keyword Search
        </button>
        <button
          role="tab"
          aria-selected={mode === "semantic"}
          className={`bops-pill ${mode === "semantic" ? "active" : ""}`}
          onClick={() => switchMode("semantic")}
        >
          Similar reported symptoms (Vector)
        </button>
      </div>

      <p className="bops-kw-hint">
        {mode === "keyword"
          ? "MongoDB Atlas Search ($search) over the knowledge collection — lexical relevance + highlights."
          : "MongoDB Vector Search ($vectorSearch, Atlas auto-embedding voyage-4) over written symptom text. Semantic retrieval of written symptoms — not waveform similarity, and not a diagnosis."}
      </p>

      <div className="bops-kw-controls">
        <input
          aria-label="Search query"
          className="bops-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Search knowledge…"
        />
        <select aria-label="Equipment type filter" className="bops-select" value={equipmentType} onChange={(e) => setEquipmentType(e.target.value)}>
          <option value="">All equipment</option>
          <option value="chiller">Chiller</option>
          <option value="pump">Pump</option>
          <option value="ahu">AHU</option>
          <option value="door_contact">Door contact</option>
          <option value="access_panel">Access panel</option>
          <option value="general">General</option>
        </select>
        <select aria-label="Document type filter" className="bops-select" value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="">All types</option>
          <option value="maintenance_procedure">Procedure</option>
          <option value="service_note">Service note</option>
          <option value="historical_incident">Historical incident</option>
        </select>
        <button className="bops-btn" onClick={() => run()} disabled={loading || !query.trim()}>
          {loading ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <div className="bops-state bops-state-error">Search error: {error}</div>}

      {result && !result.available && (
        <div className="bops-state bops-state-warn">
          <strong>Search unavailable</strong> — {result.message} (index status: {result.indexStatus})
        </div>
      )}

      {/* Facet-based navigation (keyword mode) — live counts from $searchMeta. */}
      {mode === "keyword" && result?.available && result?.facets && (
        <div className="bops-facets" aria-label="Facet navigation">
          <FacetGroup
            title="Equipment"
            buckets={result.facets.equipmentType}
            active={equipmentType}
            onPick={(v) => applyFacet("equipmentType", v)}
          />
          <FacetGroup
            title="Document type"
            buckets={result.facets.docType}
            active={docType}
            onPick={(v) => applyFacet("docType", v)}
          />
          <span className="bops-tiny">facet counts via $searchMeta · {result.facets.ms} ms</span>
        </div>
      )}

      {result?.available && (
        <div className="bops-kw-results">
          <div className="bops-kw-meta">
            {result.hits.length} result(s) · {result.queryMs} ms · score = {result.scoreLabel}
          </div>
          {result.hits.map((h: any) => {
            const selected = selectedDocIds?.includes(h.docId);
            return (
              <div className="bops-kw-card" key={h.docId}>
                <div className="bops-kw-head">
                  <span className="bops-kw-type">{h.docType.replace(/_/g, " ")}</span>
                  <span className="bops-kw-score">{Number(h.score).toFixed(3)}</span>
                </div>
                <div className="bops-kw-title">{h.title}</div>
                <div className="bops-kw-sub">
                  {h.equipmentType}
                  {h.model ? ` · ${h.model}` : ""} · {h.source} · {h.revision} · {h.docDate}
                </div>
                {/* Highlights rendered as PLAIN TEXT (never raw HTML). */}
                {h.highlights?.length ? (
                  <ul className="bops-kw-hl">
                    {h.highlights.slice(0, 3).map((frag: string, i: number) => (
                      <li key={i}>…{frag}…</li>
                    ))}
                  </ul>
                ) : (
                  <p className="bops-kw-excerpt">{h.excerpt}</p>
                )}
                {h.history && (
                  <div className="bops-kw-history">
                    <div><strong>Symptoms:</strong> {h.history.symptoms}</div>
                    <div><strong>Investigation:</strong> {h.history.investigation}</div>
                    <div><strong>Outcome:</strong> {h.history.outcome}</div>
                  </div>
                )}
                <div className="bops-kw-actions">
                  <button className="bops-btn-sm" onClick={() => viewOriginal(h.docId)}>
                    View original document
                  </button>
                  {onAttach && (
                    <button
                      className="bops-btn-sm"
                      disabled={selected}
                      onClick={() =>
                        onAttach({ docId: h.docId, title: h.title, revision: h.revision, source: h.source })
                      }
                    >
                      {selected ? "✓ Attached" : "Attach to work order"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Original document viewer (live from MongoDB) */}
      {origDoc && (
        <div className="bops-modal-overlay" onClick={() => setOrigDoc(null)}>
          <div className="bops-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bops-modal-head">
              <h2>Original document · {origDoc.collection ?? "bops_knowledge"}</h2>
              <button className="bops-btn-sm" onClick={() => setOrigDoc(null)}>✕</button>
            </div>
            {origDoc.error ? (
              <div className="bops-state bops-state-error">{origDoc.error}</div>
            ) : (
              <>
                {origDoc.note && <p className="bops-hood-note">{origDoc.note}</p>}
                <div className="bops-hood">
                  <pre>{JSON.stringify(origDoc.document, null, 2)}</pre>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FacetGroup({
  title,
  buckets,
  active,
  onPick,
}: {
  title: string;
  buckets: { value: string; count: number }[];
  active: string;
  onPick: (v: string) => void;
}) {
  if (!buckets?.length) return null;
  return (
    <div className="bops-facet-group">
      <span className="bops-facet-title">{title}</span>
      {buckets.map((b) => (
        <button
          key={b.value}
          className={`bops-facet-chip ${active === b.value ? "active" : ""}`}
          aria-pressed={active === b.value}
          onClick={() => onPick(b.value)}
        >
          {b.value.replace(/_/g, " ")} <span className="bops-facet-count">{b.count}</span>
        </button>
      ))}
    </div>
  );
}
