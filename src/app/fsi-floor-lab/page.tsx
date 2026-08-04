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
  "杭州市西湖区文一西路2002号翠湖花园6栋803",
  "杭州市西湖区文一西路2002号翠湖花园6栋0803",
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
        title: "Hybrid + 樓層/單元置頂 · 顯示的是 hybrid RRF 分",
        source:
          "顯示分數 = 底層 hybrid（$rankFusion 向量+詞法）的 { $meta: \"score\" }（RRF 分）。樓層/單元置頂只是應用層的穩定分組，不改變分數本身。",
        formula:
          "排序 = 先按樓層/單元分層（tier 0/1/2），層內按 hybrid RRF 分（穩定排序）。無加分數字。",
        detail:
          "大廈由 hybrid（向量語義 + 詞法）理解——不匹配大廈名、不用 regex、多語言通用。之後只在 hybrid 候選集之上，把 floor_num==查詢樓層（且 unit==查詢單元）的文檔穩定置頂；組內保留 hybrid 原排名。顯示的分數即 hybrid RRF 分。",
        parts: [
          { label: "hybrid RRF score（= 顯示分數）", value: s },
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

      {/* ---- Hybrid + floor/unit regroup logic dialog ---- */}
      <Modal
        open={floorLogicOpen}
        onClose={() => setFloorLogicOpen(false)}
        title="Hybrid + 樓層/單元置頂 處理邏輯"
        subtitle="樓層/單元只是「hybrid 候選集之上」的再排序——不匹配大廈名、多語言通用"
      >
        <div className="explain-section">
          <h3>① 先跑標準 hybrid 檢索（大廈由此理解）</h3>
          <div className="explain-note">
            <code>$rankFusion</code> 融合<b>向量 + 詞法</b>兩條通路。
            「翠湖花園」這種大廈／地址語義，<b>完全由 hybrid 理解</b>——
            我們的程式碼<b>不匹配大廈名、不用 regex</b>，換其他 entity
            或多語言地址一樣可用。hybrid 返回的候選集<b>已經是正確大廈</b>。
          </div>
        </div>
        <div className="explain-section">
          <h3>② 解析查詢 Parse</h3>
          <div className="explain-note">
            從查詢提取目標 <b>樓層</b> 與 <b>單元號</b>，兼容多種寫法：
            <br />
            <code>8樓 / 八樓 / 第8層 / 8F</code> ·{" "}
            <code>801室 / 801號 / 801單元 / 801</code>
            <br />
            當前解析結果：樓層{" "}
            <b style={{ color: "var(--green)" }}>{data?.parsed?.floor ?? "?"}</b>
            ，單元{" "}
            <b style={{ color: "var(--green)" }}>{data?.parsed?.unit ?? "?"}</b>
          </div>
        </div>
        <div className="explain-section">
          <h3>③ 在候選集之上分組置頂（純結構排序，無 magic number）</h3>
          <div className="feature-list">
            <div className="feature-item">
              <div className="fname">tier 0 · 精確樓層 + 精確單元</div>
              <div className="fdetail">
                floor_num == 查詢樓層 <b>且</b> unit == 查詢單元 → 目標房間，最前。
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">tier 1 · 精確樓層</div>
              <div className="fdetail">
                floor_num == 查詢樓層 → 同樓層鄰居，其次。
              </div>
            </div>
            <div className="feature-item">
              <div className="fname">tier 2 · 其餘</div>
              <div className="fdetail">其他樓層 / 無樓層資訊，排最後。</div>
            </div>
            <div className="feature-item">
              <div className="fname">組內 tie-break · hybrid 原排名（穩定排序）</div>
              <div className="fdetail">
                每層內部保留 hybrid 原順序（JS Array.sort 穩定排序）。
                <b>沒有 +100/−10 之類加分數字，也沒有樓層距離運算</b>——
                排序純粹靠離散層級。
              </div>
            </div>
          </div>
        </div>
        <div className="explain-section">
          <h3>④ 為什麼這樣設計 Why</h3>
          <div className="explain-note">
            大廈由 hybrid（向量語義 + 詞法）自己理解，<b>樓層/單元只是候選集之上的
            再排序</b>，不參與檢索、不碰大廈名。這樣換成其他 entity
            或多語言地址都能用。<br />
            舊版把樓層/單元做成獨立 <code>$rankFusion</code> 通路（對全 collection
            $match 同樓層/同單元）是錯的：它會投票給<b>其他大廈</b>的同樓層文檔，
            令「翠湖花園」這種關鍵字被忽略（查 杭州翠湖花園0803 反而返回 上海中海國際）。
            <br />
            單元號有補零（0803）與不補零（803）兩種寫法，比較時做正規化（去前導零），
            屬<b>資料正規化</b>、非排序權重。
          </div>
        </div>
      </Modal>

      {/* ---- Why hybrid + regroup is better dialog ---- */}
      <Modal
        open={whyBetterOpen}
        onClose={() => setWhyBetterOpen(false)}
        title="為何比 Baseline · Hybrid 更準？"
        subtitle="同樣的 hybrid 檢索 —— 差別只在候選集之上多做一步樓層/單元置頂"
      >
        <div className="explain-section">
          <h3>① 兩者的檢索完全相同</h3>
          <div className="explain-note">
            本欄與 Baseline · Hybrid <b>用同一個 hybrid 檢索</b>（$rankFusion
            融合向量 + 詞法），候選集一模一樣、大廈都正確。差別只在於：本欄在
            <b>候選集之上多做一步樓層/單元分組置頂</b>。
          </div>
        </div>
        <div className="explain-section">
          <h3>② Baseline · Hybrid 為何會樓層亂序</h3>
          <div className="explain-note">
            向量對「樓層數值」<b>毫無認知</b>：1801 / 501 跟 query 801
            的餘弦相似度，跟某些「寫法較遠的 8樓變體」差不多、甚至更高。於是
            <b>部分非 8樓文檔的分數高過部分 8樓文檔</b>，排序按分數倒序（排序本身
            完全正確）就出現「8樓、5樓、8樓」相間。病根在輸入信號沒有樓層，不在排序。
          </div>
        </div>
        <div className="explain-section">
          <h3>③ 本欄如何解決</h3>
          <div className="explain-note">
            在<b>同一個 hybrid 候選集之上</b>，把 floor_num == 查詢樓層 的文檔
            <b>穩定分組置頂</b>（tier 0/1/2），組內保留 hybrid 原排名。
            非同樓層文檔整批降到後面，同樓層文檔整批升到前面。
            <span style={{ color: "var(--green)" }}>
              {" "}
              top5 純度 5/5
            </span>
            。
          </div>
        </div>
        <div className="explain-note" style={{ marginTop: 8 }}>
          <b>一句話：</b>不是換了更強的檢索，而是承認「樓層是結構化欄位、不是語義」，
          於是在 hybrid 候選集之上用<b>純結構的分組排序</b>把同樓層文檔置頂——
          不碰大廈名、無 magic number、多語言通用。
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
