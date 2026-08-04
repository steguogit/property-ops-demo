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
  floorTierSearch,
  buildFloorTierPipeline,
  unitCodeVariants,
} from "@/lib/retrieval";
import { parseAddressQuery } from "@/lib/floorRank";
import { explainForMode } from "@/lib/explain";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FSI_FILTER = { metadataType: "fsi" };

/**
 * Render the pipeline as annotated pseudo-JSON so the comments sit BESIDE the
 * query lines. This shows the DESIGN: standard hybrid ($rankFusion of vector +
 * lexical) does the retrieval (building understood here); then an application-
 * layer step stably re-groups by floor/unit ON TOP of the hybrid result.
 */
function buildAnnotatedFloorPipeline(
  query: string,
  parsed: { floor?: number; unit?: string },
  pool: number
): string {
  const q = JSON.stringify(query);
  const floor = parsed.floor ?? "<未解析>";
  const unitVariants = parsed.unit
    ? JSON.stringify(unitCodeVariants(parsed.unit))
    : "[]";
  return `// 全部在同一條 aggregation pipeline 內完成（MongoDB 8.0+），無應用層排序：
[
  // ── ① Hybrid 檢索：大廈／地址語義由此理解，不匹配大廈名、不用 regex、多語言通用 ──
  {
    "$rankFusion": {                          // 官方 stage
      "input": { "pipelines": {
        "vector":  [ { "$vectorSearch": {     // 向量通路
          "index": ${JSON.stringify(env.vectorIndex)}, "path": "chunkText",
          "query": ${q}, "numCandidates": 150, "limit": ${pool},
          "filter": { "metadataType": "fsi" }
        } } ],
        "lexical": [                          // 詞法通路
          { "$search": { /* compound BM25 over chunkText / title / exactTerms … */ } },
          { "$match": { "metadataType": "fsi" } },
          { "$limit": ${pool} }
        ]
      } },
      "combination": { "weights": { "vector": 1, "lexical": 1 } }
    }
  },
  // ↑ 候選集「已經是正確大廈」——樓層／單元不參與檢索，只在下面重新排序。

  // ── ② 把 hybrid 的 RRF 分存成真欄位（$meta:"score" 只能緊接 $rankFusion 讀取）──
  { "$addFields": { "_hybridScore": { "$meta": "score" } } },

  // ── ③ 在 pipeline 內算結構化 tier（$switch，純結構，不碰大廈名）──
  { "$addFields": { "_tier": { "$switch": { "branches": [
      { "case": { "$and": [ { "$eq": ["$floor_num", ${floor}] },
                            { "$in": ["$unit_code", ${unitVariants}] } ] },  // 精確樓層+單元
        "then": 0 },
      { "case": { "$eq": ["$floor_num", ${floor}] },                          // 精確樓層
        "then": 1 }
    ], "default": 2 } } } },                                                  // 其餘

  // ── ④ 結構化排序：同樓層/單元置頂，tier 內按 hybrid 分（無 magic number）──
  { "$sort": { "_tier": 1, "_hybridScore": -1 } },
  { "$limit": ${pool} },
  { "$project": { /* 顯示欄位 + score: "$_hybridScore" + _tier */ } }
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

    // Run the three retrieval modes. The floor-regroup column is built by
    // re-ranking the SAME hybrid result (see below) — it does NOT run its own
    // retrieval, does NOT match building names, and works for any language.
    const [vec, hyb, rer] = await Promise.all([
      vectorSearch(query, Math.max(limit, 12), FSI_FILTER),
      hybridSearch(query, Math.max(limit, 12), {
        filter: FSI_FILTER,
        vectorWeight: 0.5,
        lexicalWeight: 0.5,
      }),
      vectorRerankSearch(query, limit, 25, FSI_FILTER).catch(() => []),
    ]);

    // Floor/unit tiering done ENTIRELY in one aggregation pipeline:
    // $rankFusion (hybrid) -> $addFields tier -> $sort. Building understood by
    // hybrid; floor/unit only re-order candidates. No app-side re-rank.
    const nativeFloor = await floorTierSearch(query, Math.max(limit, 12), {
      filter: FSI_FILTER,
      floor: parsed.floor,
      unit: parsed.unit,
    }).catch(() => [] as typeof hyb);

    const nativeExplain = {
      mode: "floor-tier",
      title: "Hybrid + 樓層/單元置頂（單一 aggregation pipeline）",
      features: [
        {
          name: "全部在同一條 aggregation pipeline 內完成",
          detail:
            "$rankFusion（hybrid）→ $addFields（存 RRF 分 + 算 tier）→ $sort。樓層／單元置頂在 DB 內做，不回到應用層排序。MongoDB 8.0+。",
        },
        {
          name: "① $rankFusion（向量 + 詞法）",
          detail:
            "hybrid 檢索。大廈／地址語義完全由此理解——不匹配大廈名、不用 regex，天然支援多語言。候選集已是正確大廈。",
        },
        {
          name: "② $addFields：_hybridScore + _tier",
          detail: `把 $rankFusion 的 { $meta: "score" } 存成真欄位；再用 $switch 算 tier：floor_num=${parsed.floor ?? "?"} 且 unit=${parsed.unit ?? "?"} → 0；floor_num=${parsed.floor ?? "?"} → 1；其餘 → 2。`,
        },
        {
          name: "③ $sort：{ _tier: 1, _hybridScore: -1 }",
          detail:
            "先按 tier 置頂（同樓層/單元升到最前），tier 內按 hybrid RRF 分排序。純結構排序，無 +100/−10 之類 magic number。",
        },
      ],
      stages: [
        {
          label: "單一 aggregation — $rankFusion → $addFields → $sort",
          collection: `${env.dbName}.${env.collectionName}`,
          pipeline: await buildFloorTierPipeline(query, Math.max(limit, 12), {
            filter: FSI_FILTER,
            floor: parsed.floor,
            unit: parsed.unit,
          }),
          annotatedPipeline: buildAnnotatedFloorPipeline(
            query,
            parsed,
            Math.max(limit, 12)
          ),
        },
      ],
      annotations: [
        {
          token: "$rankFusion",
          kind: "官方 stage",
          detail:
            "hybrid 檢索：融合向量 + 詞法兩條子管線。大廈語義由此理解——不匹配大廈名、不用 regex、多語言通用。返回的候選集已是正確大廈。",
        },
        {
          token: "$addFields: _hybridScore = { $meta: \"score\" }",
          kind: "官方 stage",
          detail:
            "把 $rankFusion 的 RRF 分捕捉成真欄位。$meta:\"score\" 只能在 $rankFusion 緊接之後讀取，所以要先存起來，之後重新排序才用得到。",
        },
        {
          token: "$addFields: _tier = { $switch: … }",
          kind: "官方 stage",
          detail:
            "在 pipeline 內用 $switch 依 floor_num / unit_code 算離散層級（0/1/2）。純結構，不碰大廈名。",
        },
        {
          token: "$sort: { _tier: 1, _hybridScore: -1 }",
          kind: "官方 stage",
          detail:
            "同樓層/單元（tier 小）整批置頂；tier 內按 hybrid RRF 分。全部在 DB 完成，無應用層排序、無 magic number。",
        },
      ],
      notes:
        "【全部在一條 pipeline】$rankFusion 之後直接接 $addFields + $sort，樓層/單元置頂在 aggregation 內完成，不回應用層。 【大廈由 hybrid 理解】floor/unit 只重新排序 hybrid 的候選，不匹配大廈名、不用 regex，換其他 entity 或多語言一樣可用。 【純結構排序】tier 只用離散層級（0/1/2）+ hybrid 分做 tie-break，無 +100/−10 之類 magic number。 【單元格式】unit_code 有補零（0803）與不補零（803）兩種寫法，$switch 用 $in 同時匹配兩種，屬資料正規化。",
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
        label: "Hybrid + 樓層/單元置頂",
        note: `hybrid 候選集之上分組置頂，純結構排序、不匹配大廈名`,
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
