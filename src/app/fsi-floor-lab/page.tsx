"use client";

// ===========================================================================
// FSI EXPANSION — Temporary Floor-Ranking Lab page.
//
// Side-by-side comparison of how the SAME FSI address query orders results
// under: baseline vector, baseline hybrid (RRF), $rankFusion + floor/unit arms
// (MongoDB-native), and the Voyage reranker. Purpose: demonstrate the
// floor-interleave defect and the native fix on identical data (翠湖花园6栋801).
//
// This is a standalone diagnostic page, intentionally separate from the main
// app UI. Visit /fsi-floor-lab.
// ===========================================================================

import { useState } from "react";
import { Modal, CodeBlock } from "@/components/Modal";

interface Hit {
  _id?: string;
  chunkText: string;
  floor_num?: number;
  unit_code?: string;
  block?: string;
  score?: number;
  vectorScore?: number;
  lexicalScore?: number;
  rerankScore?: number;
}
interface ExplainStage {
  label: string;
  collection: string;
  pipeline: unknown[];
  /**
   * Optional: the same pipeline rendered as annotated pseudo-JSON (with inline
   * // comments), shown instead of the raw JSON so notes sit beside the query.
   */
  annotatedPipeline?: string;
}
interface ModeExplain {
  title: string;
  features: { name: string; detail: string }[];
  stages: ExplainStage[];
  notes?: string;
  /** Optional per-token annotations explaining pipeline names / fields. */
  annotations?: { token: string; kind: string; detail: string }[];
}
interface Column {
  key: string;
  label: string;
  note: string;
  hits: Hit[];
  explain?: ModeExplain;
}
interface CompareResp {
  query: string;
  parsed: { floor?: number; unit?: string };
  columns: Column[];
}

const PRESETS = [
  "杭州市西湖区文一西路2002号翠湖花园6栋801",
  "翠湖花园6栋801",
  "深圳万科城1A座8楼0801",
  "上海中海国际3B栋51层",
];

/**
 * Floor highlight tuned for the app's DARK theme: translucent tints over the
 * dark panel background so text stays readable (matches the .pill styling).
 * Returns { bg, border, text } using the theme's colour language.
 */
function floorStyle(
  floor?: number,
  queryFloor?: number
): { background: string; borderLeft: string; color: string } {
  if (floor == null)
    return {
      background: "transparent",
      borderLeft: "3px solid var(--border)",
      color: "var(--text-dim)",
    };
  const dist = queryFloor != null ? Math.abs(floor - queryFloor) : 99;
  if (dist === 0)
    return {
      background: "rgba(0, 237, 100, 0.10)", // green = exact floor
      borderLeft: "3px solid var(--green)",
      color: "var(--text)",
    };
  if (dist <= 3)
    return {
      background: "rgba(255, 180, 84, 0.10)", // amber = near
      borderLeft: "3px solid var(--amber)",
      color: "var(--text)",
    };
  return {
    background: "rgba(255, 107, 107, 0.10)", // red = far
    borderLeft: "3px solid var(--red)",
    color: "var(--text)",
  };
}

const labBtn: React.CSSProperties = {
  padding: "3px 9px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text-dim)",
  cursor: "pointer",
  fontSize: 11,
};

/** The primary relevancy score badge text for a hit, per column/mode. */
function formatScore(columnKey: string, h: Hit): string {
  const s = h.score ?? 0;
  return s.toFixed(columnKey.startsWith("baseline-hybrid") || columnKey === "floor-rankfusion" ? 5 : 4);
}

/**
 * Mode-aware explanation of how the shown relevancy score is computed, and its
 * source ($meta field / pipeline). Returned as structured content for a dialog.
 */
function scoreInfo(
  columnKey: string,
  h: Hit
): {
  title: string;
  source: string;
  formula: string;
  detail: string;
  parts: { label: string; value: string }[];
} {
  const v = h.vectorScore != null ? h.vectorScore.toFixed(4) : "—";
  const l = h.lexicalScore != null ? h.lexicalScore.toFixed(4) : "—";
  const r = h.rerankScore != null ? h.rerankScore.toFixed(4) : "—";
  const s = h.score != null ? h.score.toFixed(5) : "—";

  switch (columnKey) {
    case "baseline-vector":
      return {
        title: "Vector · 餘弦相似度",
        source:
          "來源：$vectorSearch 的搜尋 metadata，透過 { $meta: \"vectorSearchScore\" } 取得。",
        formula: "score = cosine(queryVector, docVector)  ∈ [0, 1]",
        detail:
          "由 Atlas Vector Search 對查詢向量與文檔向量做近似最近鄰計算的餘弦相似度，越接近 1 越相似。純語義，不含樓層/字面信號。",
        parts: [{ label: "vectorSearchScore（= 顯示分數）", value: s }],
      };
    case "baseline-hybrid":
      return {
        title: "Hybrid · RRF 融合分",
        source:
          "來源：$rankFusion 輸出的 { $meta: \"score\" }（RRF 分）。向量、詞法通路的分數來自各自的 scoreDetails。",
        formula:
          "score(d) = Σ_通路  weightᵢ × 1 / (60 + rankᵢ(d))   （60 為 MongoDB 固定常數）",
        detail:
          "向量檢索通路與詞法檢索通路（各權重 0.5）各自對文檔排名，MongoDB 用官方 Reciprocal Rank Fusion 融合成一個分數。顯示分數是 RRF 分本身，並非餘弦或 BM25。",
        parts: [
          { label: "RRF score（= 顯示分數）", value: s },
          { label: "向量檢索通路 · vectorSearchScore（餘弦）", value: v },
          { label: "詞法檢索通路 · searchScore（BM25）", value: l },
        ],
      };
    case "floor-rankfusion":
      return {
        title: "$rankFusion + Floor · RRF 融合分",
        source:
          "來源：$rankFusion 輸出的 { $meta: \"score\" }（RRF 分），輸入為 向量+詞法+樓層+單元 四條檢索通路。",
        formula:
          "score(d) = Σ_通路  weightᵢ × 1 / (60 + rankᵢ(d))   （unitExact 權重 2，其餘 1）",
        detail:
          "同樣是官方 RRF，但多了樓層精確通路、單元精確通路兩條用結構化欄位精確過濾的通路。同樓層／目標單元文檔因多出現在這兩條通路而多得票，RRF 分被顯著抬高。",
        parts: [
          { label: "RRF score（= 顯示分數）", value: s },
          { label: "向量檢索通路 · vectorSearchScore（餘弦）", value: v },
          { label: "詞法檢索通路 · searchScore（BM25）", value: l },
        ],
      };
    case "rerank":
      return {
        title: "Reranker · 相關性分",
        source:
          "來源：Voyage rerank-2.5（Atlas Model API）對候選集重排後回傳的 relevanceScore。",
        formula: "score = reranker.relevanceScore(query, document)  ∈ [0, 1]",
        detail:
          "先用 vector + lexical 取候選池，再交給交叉編碼 reranker 逐一評估「查詢 ↔ 文檔」相關性。顯示分數是 reranker 的 relevanceScore，與前面的餘弦/RRF 不同量綱。",
        parts: [
          { label: "rerankScore（= 顯示分數）", value: r },
          { label: "候選池 vector 分（參考）", value: v },
          { label: "候選池 lexical 分（參考）", value: l },
        ],
      };
    default:
      return {
        title: "分數",
        source: "—",
        formula: "—",
        detail: "—",
        parts: [{ label: "score", value: s }],
      };
  }
}

export default function FloorLab() {
  const [query, setQuery] = useState(PRESETS[0]);
  const [data, setData] = useState<CompareResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Dialog state
  const [explainModal, setExplainModal] = useState<ModeExplain | null>(null);
  const [floorLogicOpen, setFloorLogicOpen] = useState(false);
  const [whyBetterOpen, setWhyBetterOpen] = useState(false);
  const [scoreModal, setScoreModal] = useState<{
    columnKey: string;
    hit: Hit;
  } | null>(null);
  const [docModal, setDocModal] = useState<{
    id: string;
    doc: unknown | null;
    loading: boolean;
    error?: string;
  } | null>(null);

  async function openDoc(id?: string) {
    if (!id) return;
    setDocModal({ id, doc: null, loading: true });
    try {
      const res = await fetch(`/api/fsi-chunk/${encodeURIComponent(id)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "not found");
      setDocModal({ id, doc: j.document, loading: false });
    } catch (e: any) {
      setDocModal({ id, doc: null, loading: false, error: e?.message ?? "failed" });
    }
  }

  async function run(q?: string) {
    const theQuery = q ?? query;
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const res = await fetch("/api/fsi-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: theQuery, limit: 8 }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "request failed");
      setData(j);
    } catch (e: any) {
      setErr(e?.message ?? "failed");
    } finally {
      setLoading(false);
    }
  }

  const qFloor = data?.parsed?.floor;

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1400,
        margin: "0 auto",
        color: "var(--text)",
      }}
    >
      <h1 style={{ margin: 0, color: "var(--text)" }}>FSI Floor-Ranking Lab</h1>
      <p style={{ color: "var(--text-dim)", marginTop: 4 }}>
        同一組數據、同一查詢，比較：無樓層排序 (客戶現狀) vs $rankFusion+Floor
        (MongoDB 原生) vs Reranker。
        <span style={{ color: "var(--green)" }}> 綠=樓層精確匹配</span>
        <span style={{ color: "var(--amber)" }}> 黃=相鄰</span>
        <span style={{ color: "var(--red)" }}> 紅=樓層偏離</span>。
      </p>

      <div style={{ display: "flex", gap: 8, margin: "12px 0", flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          style={{
            flex: "1 1 420px",
            padding: "9px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 14,
            background: "var(--bg-soft)",
            color: "var(--text)",
          }}
        />
        <button
          onClick={() => run()}
          disabled={loading}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            border: "1px solid var(--green)",
            background: "var(--green)",
            color: "#06281a",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {loading ? "查詢中…" : "比較排序"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => {
              setQuery(p);
              run(p);
            }}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--panel-2)",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {err && <div style={{ color: "var(--red)" }}>錯誤：{err}</div>}

      {data && (
        <>
          <div
            style={{
              marginBottom: 12,
              fontSize: 14,
              color: "var(--text-dim)",
            }}
          >
            解析查詢 → 樓層{" "}
            <b style={{ color: "var(--green)" }}>{data.parsed?.floor ?? "?"}</b>
            ，單元{" "}
            <b style={{ color: "var(--green)" }}>{data.parsed?.unit ?? "?"}</b>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${data.columns.length}, 1fr)`,
              gap: 12,
            }}
          >
            {data.columns.map((col) => (
              <div
                key={col.key}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                  background: "var(--panel)",
                }}
              >
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--panel-2)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      color: "var(--text)",
                    }}
                  >
                    {col.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                    {col.note}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      marginTop: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    {col.explain && (
                      <button
                        onClick={() => setExplainModal(col.explain!)}
                        style={labBtn}
                      >
                        查看 Query
                      </button>
                    )}
                    {col.key === "floor-rankfusion" && (
                      <>
                        <button
                          onClick={() => setFloorLogicOpen(true)}
                          style={{ ...labBtn, borderColor: "var(--green-dim)", color: "var(--green)" }}
                        >
                          樓層處理邏輯
                        </button>
                        <button
                          onClick={() => setWhyBetterOpen(true)}
                          style={{ ...labBtn, borderColor: "var(--blue)", color: "var(--blue)" }}
                        >
                          為何比 Hybrid 準
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {col.hits.length === 0 && (
                    <li
                      style={{
                        padding: 10,
                        color: "var(--text-faint)",
                        fontSize: 12,
                      }}
                    >
                      (無結果)
                    </li>
                  )}
                  {col.hits.map((h, i) => {
                    const fs = floorStyle(h.floor_num, qFloor);
                    return (
                      <li
                        key={i}
                        onClick={() => openDoc(h._id)}
                        title={h._id ? "點擊查看 MongoDB 文檔" : undefined}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          padding: "7px 10px",
                          borderTop: "1px solid var(--border-soft)",
                          background: fs.background,
                          borderLeft: fs.borderLeft,
                          color: fs.color,
                          fontSize: 12.5,
                          cursor: h._id ? "pointer" : "default",
                        }}
                      >
                        <span
                          style={{
                            flex: "0 0 auto",
                            minWidth: 16,
                            fontWeight: 700,
                            color: "var(--text-dim)",
                          }}
                        >
                          {i + 1}.
                        </span>
                        <span
                          style={{
                            flex: "1 1 auto",
                            minWidth: 0,
                            lineHeight: 1.5,
                            wordBreak: "break-word",
                          }}
                        >
                          <span
                            style={{ fontWeight: 700, color: "var(--text)" }}
                          >
                            [{h.block ?? "?"}座 {h.floor_num ?? "?"}楼{" "}
                            {h.unit_code ?? "?"}]
                          </span>{" "}
                          <span style={{ color: "var(--text-dim)" }}>
                            {h.chunkText}
                          </span>
                        </span>
                        {h.score != null && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setScoreModal({ columnKey: col.key, hit: h });
                            }}
                            title="點擊查看分數計算方式與源頭"
                            style={{
                              flex: "0 0 auto",
                              alignSelf: "center",
                              whiteSpace: "nowrap",
                              fontFamily: "ui-monospace, Menlo, monospace",
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "1px 6px",
                              borderRadius: 5,
                              border: "1px solid var(--border)",
                              background: "var(--bg-soft)",
                              color: "var(--green)",
                              cursor: "pointer",
                            }}
                          >
                            {formatScore(col.key, h)}
                          </span>
                        )}
                        {h._id && (
                          <span
                            style={{
                              flex: "0 0 auto",
                              alignSelf: "center",
                              whiteSpace: "nowrap",
                              fontSize: 10.5,
                              color: "var(--blue)",
                              opacity: 0.85,
                            }}
                          >
                            查看文檔 ›
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---- Explain (actual query / pipeline) modal ---- */}
      <Modal
        open={!!explainModal}
        onClose={() => setExplainModal(null)}
        title={explainModal ? `${explainModal.title} — 實際查詢` : ""}
        subtitle="該模式實際執行的 MongoDB 聚合管線與所用能力"
      >
        {explainModal && (
          <>
            <div className="explain-section">
              <h3>所用能力 Features</h3>
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
              <h3>實際執行的查詢 Query executed</h3>
              {explainModal.stages.map((s, i) => (
                <div key={i}>
                  <div className="stage-label">{s.label}</div>
                  <div className="stage-coll">{s.collection}</div>
                  {/* If an annotated version exists, show it (inline // comments
                      beside the query). Otherwise render the raw JSON. */}
                  <CodeBlock value={s.annotatedPipeline ?? s.pipeline} />
                </div>
              ))}
            </div>
            {explainModal.annotations &&
              explainModal.annotations.length > 0 && (
                <div className="explain-section">
                  <h3>查詢注釋 Annotations</h3>
                  <div className="feature-list">
                    {explainModal.annotations.map((a) => (
                      <div className="feature-item" key={a.token}>
                        <div className="fname">
                          <code>{a.token}</code>{" "}
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 500,
                              color:
                                a.kind === "官方 stage" ||
                                a.kind === "官方欄位"
                                  ? "var(--green)"
                                  : "var(--amber)",
                            }}
                          >
                            · {a.kind}
                          </span>
                        </div>
                        <div className="fdetail">{a.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            {explainModal.notes && (
              <div className="explain-section">
                <h3>說明 Notes</h3>
                <div className="explain-note">{explainModal.notes}</div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* ---- $rankFusion + Floor ranking logic dialog (MongoDB-native) ---- */}
      <Modal
        open={floorLogicOpen}
        onClose={() => setFloorLogicOpen(false)}
        title="$rankFusion + Floor 樓層處理邏輯"
        subtitle="用 MongoDB 原生 RRF（無 magic number）修復樓層亂序"
      >
        <div className="explain-section">
          <h3>① 解析查詢 Parse</h3>
          <div className="explain-note">
            從地址文本中提取目標 <b>樓層</b> 與 <b>單元號</b>，兼容多種寫法：
            <br />
            <code>8樓 / 八樓 / 第8層 / 8F</code> ·{" "}
            <code>801室 / 801號 / 801單元 / 801</code>
            <br />
            當前查詢解析結果：樓層{" "}
            <b style={{ color: "var(--green)" }}>{data?.parsed?.floor ?? "?"}</b>
            ，單元{" "}
            <b style={{ color: "var(--green)" }}>{data?.parsed?.unit ?? "?"}</b>
          </div>
        </div>
        <div className="explain-section">
          <h3>② $rankFusion 的四條檢索通路 Input pipelines</h3>
          <div className="feature-list">
            <div className="feature-item">
              <div className="fname">向量檢索通路 · $vectorSearch（權重 1）</div>
              <div className="fdetail">語義候選召回。</div>
            </div>
            <div className="feature-item">
              <div className="fname">詞法檢索通路 · $search BM25（權重 1）</div>
              <div className="fdetail">字面 ／ 精確詞召回。</div>
            </div>
            <div className="feature-item">
              <div className="fname">
                樓層精確通路 · $match(floor_num=查詢樓層) + $sort（權重 1）
              </div>
              <div className="fdetail">
                只包含同樓層文檔的檢索通路。這些文檔因多出現在一條通路，
                獲得額外 RRF 票數 → 同樓層自然被抬到頂部。
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">
                單元精確通路 · $match(unit_code=查詢單元) + $sort（權重 2）
              </div>
              <div className="fdetail">
                只包含目標單元的檢索通路，權重 2 → 被查詢單元本身排最前。
              </div>
            </div>
          </div>
        </div>
        <div className="explain-section">
          <h3>③ 融合方式 Fusion · 官方 RRF（weight 如何計算）</h3>
          <div className="explain-note">
            <b>combination 不是獨立 operator</b>，而是 <code>$rankFusion</code>{" "}
            的內部欄位。weight 的計算<b>完全由 MongoDB 引擎</b>按官方 Reciprocal
            Rank Fusion 公式完成，我哋只係聲明各條通路的乘數：
            <br />
            <code style={{ display: "inline-block", margin: "6px 0" }}>
              score(d) = Σ_通路  weightᵢ × 1 / (60 + rankᵢ(d))
            </code>
            <br />
            <span style={{ color: "var(--text-dim)" }}>
              rankᵢ(d) = 文檔 d 在第 i 條通路輸出中的名次；60 = MongoDB 固定敏感度常數；
              weightᵢ = combination.weights 給該通路的數字。文檔若不在某條通路出現，該項不計。
            </span>
          </div>
          <div className="feature-list" style={{ marginTop: 8 }}>
            <div className="feature-item">
              <div className="fname">實例：查「6栋801」時 801室（在全部四條通路）</div>
              <div className="fdetail">
                RRF ≈ (1 + 1 + 1 + <b>2</b>) / (60 + 1) = 5/61 ≈{" "}
                <b style={{ color: "var(--green)" }}>0.082</b>
                （unitExact 權重 2）
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">對比：803室（不在單元精確通路）</div>
              <div className="fdetail">
                少了最重（權重 2）那一票 → RRF 分較低 → 被引擎排在 801 之後。
                這就是 weight 的實際作用：只是公式中的乘數，
                <b>沒有任何手寫加分邏輯</b>。
              </div>
            </div>
          </div>
        </div>
        <div className="explain-section">
          <h3>④ 為什麼需要這一步 Why</h3>
          <div className="explain-note">
            純 vector / hybrid 檢索只按語義分排序。801 / 803 / 501 三者文本幾乎相同，
            餘弦分差 &lt; 0.5%，樓層數值差異被向量抹平 → 出現「8樓、5樓、8樓」相間。
            額外的樓層、單元兩條檢索通路補上「樓層鄰近度」這一結構化信號，
            <b> 無需重建任何索引</b>，即可修復亂序。要求 MongoDB 8.0+；
            升級 8.2 可用 <code>$score</code> 表達式，8.3 可用{" "}
            <code>$scoreFusion</code>。
          </div>
        </div>
      </Modal>

      {/* ---- Why $rankFusion+Floor beats Baseline Hybrid dialog ---- */}
      <Modal
        open={whyBetterOpen}
        onClose={() => setWhyBetterOpen(false)}
        title="為何比 Baseline · Hybrid 更準？"
        subtitle="同一個 $rankFusion / RRF —— 差別在於「餵咩檢索通路入去」"
      >
        <div className="explain-section">
          <h3>① 關鍵：兩者用的是同一個 RRF</h3>
          <div className="explain-note">
            <b>不是「RRF 更準」</b>。Baseline · Hybrid 同 $rankFusion + Floor
            都係用 MongoDB 同一個 <code>$rankFusion</code> stage、同一條 RRF
            公式。差別只在於<b>輸入了哪些檢索通路</b>——即「餵咩信號俾 RRF」。
          </div>
        </div>
        <div className="explain-section">
          <h3>② Baseline · Hybrid 的兩條通路都「不識樓層」</h3>
          <div className="feature-list">
            <div className="feature-item">
              <div className="fname">向量檢索通路 · 語義相似度</div>
              <div className="fdetail">
                801 / 803 / 501 字串幾乎相同，向量餘弦分差 &lt; 0.5% →
                樓層數值差異被抹平，向量檢索通路根本分不清 8 樓還是 5 樓。
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">詞法檢索通路 · BM25 字面</div>
              <div className="fdetail">
                「翠湖花园6栋」等共同詞在 5/8/18 樓文檔都出現 →
                詞法檢索通路給它們差不多的名次，同樣沒有樓層信號。
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">結果：garbage in, garbage out</div>
              <div className="fdetail">
                兩條通路都沒有樓層信號，RRF 融合再好也救不回 →
                5 樓 / 18 樓穿插進 8 樓群。
              </div>
            </div>
          </div>
        </div>
        <div className="explain-section">
          <h3>③ $rankFusion + Floor 多了兩條「識樓層」的檢索通路</h3>
          <div className="explain-note">
            樓層精確通路 = <code>$match(&#123;floor_num: 8&#125;)</code> —— 用
            <b>結構化欄位精確過濾</b>，只包含 8 樓文檔；5 樓 / 18 樓根本不出現在
            這條通路。單元精確通路（權重 2）再把目標單元頂上去。這兩條通路把「這份文檔
            <b>確實在 8 樓</b>」這個確定信號投票進 RRF。
          </div>
        </div>
        <div className="explain-section">
          <h3>④ 實測 RRF 分（客戶原例 6栋801）</h3>
          <div className="feature-list">
            <div className="feature-item">
              <div className="fname">Baseline · Hybrid（兩條通路）</div>
              <div className="fdetail">
                801 rrf=<b>0.01639</b> vs 501 rrf=<b>0.01517</b> ——
                差距僅 0.001，微弱易穿插；
                <span style={{ color: "var(--red)" }}>
                  {" "}
                  #5=18楼1801、#6=5楼501 穿插，top5 純度 4/5
                </span>
                。
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">$rankFusion + Floor（四條通路）</div>
              <div className="fdetail">
                801 rrf=<b style={{ color: "var(--green)" }}>0.06404</b>
                （多了 floorExact + unitExact 兩票，其中一票權重 2）→
                拉開約 4 倍；
                <span style={{ color: "var(--green)" }}>
                  {" "}
                  501 直接跌出 top10，top5 純度 5/5
                </span>
                。
              </div>
            </div>
          </div>
          <div className="explain-note" style={{ marginTop: 8 }}>
            <b>一句話：</b>不是 RRF 更準，而是「餵了更準的信號俾 RRF」。額外兩條通路
            用結構化 <code>floor_num</code> / <code>unit_code</code>
            精確過濾，把同樓層文檔壓到頂部。
          </div>
        </div>
      </Modal>

      {/* ---- Relevancy score explanation dialog ---- */}
      <Modal
        open={!!scoreModal}
        onClose={() => setScoreModal(null)}
        title={
          scoreModal
            ? `分數計算方式 — ${scoreInfo(scoreModal.columnKey, scoreModal.hit).title}`
            : ""
        }
        subtitle={
          scoreModal
            ? `${scoreModal.hit.floor_num ?? "?"}楼 ${scoreModal.hit.unit_code ?? "?"} · ${scoreModal.hit.chunkText}`
            : ""
        }
      >
        {scoreModal &&
          (() => {
            const info = scoreInfo(scoreModal.columnKey, scoreModal.hit);
            return (
              <>
                <div className="explain-section">
                  <h3>顯示分數 Score</h3>
                  <div
                    className="explain-note"
                    style={{
                      fontFamily: "ui-monospace, Menlo, monospace",
                      fontSize: 18,
                      fontWeight: 700,
                      color: "var(--green)",
                    }}
                  >
                    {formatScore(scoreModal.columnKey, scoreModal.hit)}
                  </div>
                </div>
                <div className="explain-section">
                  <h3>計算公式 Formula</h3>
                  <div className="codeblock">
                    <pre>
                      <code>{info.formula}</code>
                    </pre>
                  </div>
                </div>
                <div className="explain-section">
                  <h3>分數來源 Source</h3>
                  <div className="explain-note">{info.source}</div>
                </div>
                <div className="explain-section">
                  <h3>各項分數 Breakdown</h3>
                  <div className="feature-list">
                    {info.parts.map((p) => (
                      <div className="feature-item" key={p.label}>
                        <div className="fname">{p.label}</div>
                        <div
                          className="fdetail"
                          style={{
                            fontFamily: "ui-monospace, Menlo, monospace",
                            color: "var(--text)",
                          }}
                        >
                          {p.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="explain-section">
                  <h3>說明 Notes</h3>
                  <div className="explain-note">{info.detail}</div>
                </div>
              </>
            );
          })()}
      </Modal>

      {/* ---- Raw MongoDB document viewer ---- */}
      <Modal
        open={!!docModal}
        onClose={() => setDocModal(null)}
        title="MongoDB 文檔 (chunks collection)"
        subtitle={docModal ? `_id: ${docModal.id}` : ""}
      >
        {docModal?.loading && (
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>載入中…</div>
        )}
        {docModal?.error && (
          <div style={{ color: "var(--red)", fontSize: 13 }}>
            錯誤：{docModal.error}
          </div>
        )}
        {docModal?.doc != null && (
          <div className="explain-section">
            <h3>原始文檔 Raw document（已隱藏 embedding 向量）</h3>
            <CodeBlock value={docModal.doc} />
          </div>
        )}
      </Modal>
    </div>
  );
}
