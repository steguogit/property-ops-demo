// ===========================================================================
// FSI EXPANSION — Floor-ranking comparison lab (temporary demo endpoint).
//
// Runs ONE address query against the FSI dataset and returns four orderings so
// the floor-interleave problem and the native fix can be compared side by side
// on identical data:
//
//   1. baseline-vector    : pure $vectorSearch order (what the customer sees)
//   2. baseline-hybrid     : $rankFusion (RRF) order  (also interleaves)
//   3. floor-rankfusion    : $rankFusion + floor/unit ranked arms (MongoDB-native)
//   4. rerank              : Voyage reranker order (if configured)
//
// The hand-written heuristic column was removed after A/B testing showed the
// native $rankFusion floor arm is equally accurate (10/10 + edge cases) while
// using MongoDB's own RRF instead of magic numbers.
//
// All arms are filtered to metadataType=fsi.
// ===========================================================================

import { NextRequest, NextResponse } from "next/server";
import {
  vectorSearch,
  hybridSearch,
  vectorRerankSearch,
  floorRankFusionSearch,
  buildFloorRankFusionPipeline,
} from "@/lib/retrieval";
import { parseAddressQuery } from "@/lib/floorRank";
import { explainForMode } from "@/lib/explain";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FSI_FILTER = { metadataType: "fsi" };

/**
 * Render the native $rankFusion + floor pipeline as annotated pseudo-JSON so the
 * explanation comments sit BESIDE the query lines (like source-code comments),
 * rather than in a separate block. The shape mirrors buildFloorRankFusionPipeline.
 */
function buildAnnotatedFloorPipeline(
  query: string,
  parsed: { floor?: number; unit?: string },
  pool: number
): string {
  const q = JSON.stringify(query);
  const floor = parsed.floor ?? "<未解析>";
  const unit = parsed.unit ?? "<未解析>";
  return `[
  {
    "$rankFusion": {                          // 官方 stage：MongoDB 8.0+ 原生混合檢索
      "input": {
        "pipelines": {                        // $rankFusion 內部欄位（非 operator）
                                              //   下面 4 個鍵名都係我哋自訂的 pipeline 名稱（每個對應一條檢索通路）

          "vector": [                         // 向量檢索通路（pipeline 名稱自訂）
            { "$vectorSearch": {              // 官方 stage
              "index": ${JSON.stringify(env.vectorIndex)},
              "path": "chunkText",
              "query": ${q},
              "numCandidates": 150,
              "limit": ${pool},
              "filter": { "metadataType": "fsi" }   // 每條通路各自過濾（$rankFusion 無共享前置 $match）
            } }
          ],

          "lexical": [                        // 詞法檢索通路（pipeline 名稱自訂）
            { "$search": { /* compound BM25 over chunkText / title / exactTerms … */ } },
            { "$match": { "metadataType": "fsi" } },  // 同樣每條通路各自過濾
            { "$limit": ${pool} }
          ],

          "floorExact": [                     // 樓層精確通路（pipeline 名稱自訂）
            { "$match": {
                "metadataType": "fsi",
                "floor_num": ${floor}         // ← 由查詢解析出的樓層
            } },
            { "$sort": { "unit_code": 1, "_id": 1 } },  // 排序（排序後才可作為 $rankFusion 的輸入子管線）
            { "$limit": ${pool} }
          ],

          "unitExact": [                      // 單元精確通路（pipeline 名稱自訂）
            { "$match": {
                "metadataType": "fsi",
                "unit_code": ${JSON.stringify(unit)}    // ← 由查詢解析出的單元
            } },
            { "$sort": { "floor_num": 1, "_id": 1 } },
            { "$limit": ${pool} }
          ]
        }
      },
      "combination": {                        // $rankFusion 內部欄位（非 operator）
        "weights": {                          // 只係「聲明各條通路在 RRF 公式中的乘數」
          "vector": 1,                        //   實際計算由引擎按官方 RRF 公式做：
          "lexical": 1,                       //   score(d) = Σ weightᵢ × 1/(60 + rankᵢ(d))
          "floorExact": 1,
          "unitExact": 2                      // ← 目標單元多一票、且權重 2 → 置頂
        }
      },
      "scoreDetails": true                    // 輸出每份文檔的 RRF 分解（供除錯／展示）
    }
  },
  { "$limit": ${pool} },
  { "$project": { /* 顯示欄位 + score:{$meta:"score"} + scoreDetails */ } }
]`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = body.limit ?? 8;
    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const parsed = parseAddressQuery(query);

    // Run all four modes on the same query. The floor-rankfusion arm uses the
    // parsed floor/unit to add native $rankFusion ranked arms.
    const [vec, hyb, rer, nativeFloor] = await Promise.all([
      vectorSearch(query, Math.max(limit, 12), FSI_FILTER),
      hybridSearch(query, Math.max(limit, 12), {
        filter: FSI_FILTER,
        vectorWeight: 0.5,
        lexicalWeight: 0.5,
      }),
      vectorRerankSearch(query, limit, 25, FSI_FILTER).catch(() => []),
      // MongoDB-native: $rankFusion with extra floor/unit ranked arms (RRF).
      floorRankFusionSearch(query, Math.max(limit, 12), {
        filter: FSI_FILTER,
        floor: parsed.floor,
        unit: parsed.unit,
      }).catch(() => []),
    ]);

    // Real pipeline for the native arm (shown in the explain modal).
    const nativePipeline = await buildFloorRankFusionPipeline(
      query,
      Math.max(limit, 12),
      { filter: FSI_FILTER, floor: parsed.floor, unit: parsed.unit }
    );
    const nativeExplain = {
      mode: "floor-rankfusion",
      title: "$rankFusion + 樓層通路 (MongoDB 原生 RRF)",
      features: [
        {
          name: "$rankFusion (Reciprocal Rank Fusion, k=60)",
          detail:
            "MongoDB 原生混合檢索。將多條檢索通路（各自排序後作為輸入子管線）的排名用官方 RRF 公式融合，權重可配置——無需手寫加分公式或 magic number。要求 MongoDB 8.0+。",
        },
        {
          name: "向量檢索通路（$vectorSearch）",
          detail: "語義候選召回。",
        },
        {
          name: "詞法檢索通路（$search, BM25）",
          detail: "字面／精確詞召回。",
        },
        {
          name: "樓層精確通路（$match + $sort）",
          detail: `僅包含樓層 = ${parsed.floor ?? "?"} 的文檔的檢索通路。這些文檔因多出現在一條通路而獲得額外 RRF 票數，自然被抬到同樓層組頂部。`,
        },
        {
          name: "單元精確通路（$match + $sort）",
          detail: `僅包含單元 = ${parsed.unit ?? "?"} 的文檔（權重 2），被查詢單元本身排最前。`,
        },
      ],
      stages: [
        {
          label: "單條聚合 — $rankFusion（向量 + 詞法 + 樓層 + 單元 四條檢索通路）",
          collection: `${env.dbName}.${env.collectionName}`,
          pipeline: nativePipeline,
          annotatedPipeline: buildAnnotatedFloorPipeline(
            query,
            parsed,
            Math.max(limit, 12)
          ),
        },
      ],
      // Annotations clarifying which tokens are official MongoDB stages/fields
      // and which are just our arbitrary pipeline NAMES.
      annotations: [
        {
          token: "$rankFusion",
          kind: "官方 stage",
          detail:
            "MongoDB 8.0+ 原生聚合 stage。接收多條輸入子管線（每條對應一條檢索通路），用官方 RRF 演算法融合排名。",
        },
        {
          token: "input.pipelines",
          kind: "$rankFusion 內部欄位",
          detail:
            "$rankFusion spec 的子欄位（不是獨立 operator），值是一個「pipeline 名稱 → 子管線」的對映。下面 vector/lexical/floorExact/unitExact 都係我哋自訂的 pipeline 名稱（各對應一條檢索通路）。",
        },
        {
          token: "vector / lexical / floorExact / unitExact",
          kind: "自訂 pipeline 名稱",
          detail:
            "呢啲唔係 stage，只係 input.pipelines 裏面的鍵名（可任意命名，各代表一條檢索通路）。每條子管線內部用的先係真正的官方 stage。",
        },
        {
          token: "$vectorSearch / $search / $match / $sort / $limit",
          kind: "官方 stage",
          detail:
            "各條通路內部用的都是 MongoDB 官方 stage：$vectorSearch（語義）、$search（BM25）、$match（過濾同樓層／單元）、$sort（排序後才可作為輸入子管線）、$limit。",
        },
        {
          token: "combination / combination.weights",
          kind: "$rankFusion 內部欄位",
          detail:
            "combination 不是獨立的 aggregation operator，而是 $rankFusion spec 的子欄位；weights 只是「聲明每條檢索通路在 RRF 公式中的乘數」。實際的 weight 計算由 MongoDB 引擎按官方 RRF 公式完成，不是我哋自己算（見下方 Notes 的公式與實例）。",
        },
      ],
      notes:
        "【weight 如何計算】combination 不是獨立 operator，而是 $rankFusion 的內部欄位。weight 計算完全由 MongoDB 引擎按官方 RRF 公式完成：score(d) = Σ_通路 weightᵢ × 1/(60 + rankᵢ(d))；rankᵢ(d) 是文檔 d 在第 i 條通路輸出中的名次，60 是 MongoDB 定義的固定敏感度常數，weightᵢ 就是 combination.weights 裏你給該通路的數字。文檔若不出現在某條通路，該項不計。實例：查 6栋801 時，801室 出現在全部四條通路，RRF 分 = (1+1+1+2)/61 ≈ 0.082（unitExact 權重 2）；803室 不在單元精確通路，少了最重那一票，分數較低 → 被引擎排在 801 之後。這就是 weight 的實際作用：只是公式中的乘數，沒有任何手寫加分邏輯。 【關於重複的 $match】$rankFusion 每條子管線獨立執行，沒有共享前置 $match，因此 metadataType:'fsi' 過濾必須在每條通路各自出現——是固有結構、不是冗餘；程式碼層已用統一 helper 生成。 【版本】要求 MongoDB 8.0+；升級 8.2 可用 $score 表達式，8.3 可用 $scoreFusion。",
    };

    const columns = [
      {
        key: "baseline-vector",
        label: "Baseline · Vector (客戶現狀)",
        note: "純 $vectorSearch，無樓層排序",
        parsed: null,
        hits: vec.slice(0, limit),
        explain: explainForMode("vector", query, Math.max(limit, 12), {}),
      },
      {
        key: "baseline-hybrid",
        label: "Baseline · Hybrid (RRF)",
        note: "$rankFusion，無樓層排序",
        parsed: null,
        hits: hyb.slice(0, limit),
        explain: explainForMode("hybrid", query, Math.max(limit, 12), {}),
      },
      {
        key: "floor-rankfusion",
        label: "$rankFusion + Floor (MongoDB 原生)",
        note: `官方 RRF 融合，樓層／單元通路加票，無 magic number`,
        parsed,
        hits: (nativeFloor as any[]).slice(0, limit),
        explain: nativeExplain,
      },
      {
        key: "rerank",
        label: "Reranker (Voyage rerank-2.5)",
        note: rer.length ? "語義重排" : "未配置 ／ 無結果",
        parsed: null,
        hits: (rer as any[]).slice(0, limit),
        explain: explainForMode("rerank", query, limit, {}),
      },
    ];

    return NextResponse.json({ query, parsed, columns });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "compare failed" },
      { status: 500 }
    );
  }
}
