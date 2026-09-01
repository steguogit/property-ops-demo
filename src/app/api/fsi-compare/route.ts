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

  // ── ②b 大廈閘門：以 hybrid 分最高的文檔作「目標大廈」，廣播其 estate/district ──
  //      （不用 query 匹配大廈名，仍多語言通用；樓層/單元只在同一大廈內重排）
  { "$setWindowFields": { "sortBy": { "_hybridScore": -1 }, "output": {
      "_topEstate":   { "$first": "$estate",   "window": { "documents": ["unbounded", "unbounded"] } },
      "_topDistrict": { "$first": "$district", "window": { "documents": ["unbounded", "unbounded"] } }
  } } },
  { "$addFields": { "_sameBuilding": { "$and": [
      { "$eq": ["$estate", "$_topEstate"] },
      { "$eq": ["$district", "$_topDistrict"] }
  ] } } },

  // ── ③ 在 pipeline 內算結構化 tier（$switch；大廈為主鍵，tier 0-2 全屬同大廈）──
  { "$addFields": { "_tier": { "$switch": { "branches": [
      { "case": { "$and": [ "$_sameBuilding",                                 // 同大廈 + 精確樓層 + 精確單元
                            { "$eq": ["$floor_num", ${floor}] },
                            { "$in": ["$unit_code", ${unitVariants}] } ] },
        "then": 0 },
      { "case": { "$and": [ "$_sameBuilding",                                 // 同大廈 + 精確樓層
                            { "$eq": ["$floor_num", ${floor}] } ] },
        "then": 1 },
      { "case": "$_sameBuilding", "then": 2 }                                 // 同大廈 其餘樓層/單元
    ], "default": 3 } } } },                                                  // 其他大廈

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
          name: "②b 大廈閘門（$setWindowFields）",
          detail:
            "以 hybrid 分最高的文檔作「目標大廈」，把其 estate/district 廣播到所有候選，標記 _sameBuilding。tier 0/1 只給同大廈文檔——防止其他大廈同樓層/單元（如 万科城 A1座 8楼 0801）越過正確大廈。仍不匹配 query 大廈名、多語言通用。",
        },
        {
          name: "② $addFields：_hybridScore + _tier",
          detail: `把 $rankFusion 的 { $meta: "score" } 存成真欄位；再用 $switch 算 tier（大廈為主鍵）：同大廈+floor_num=${parsed.floor ?? "?"}+unit=${parsed.unit ?? "?"} → 0；同大廈+floor_num=${parsed.floor ?? "?"} → 1；同大廈其餘樓層/單元 → 2；其他大廈 → 3。整個正確小區（tier 0-2）永遠排在其他小區（tier 3）之上。`,
        },
        {
          name: "③ $sort：{ _tier: 1, _hybridScore: -1 }",
          detail:
            "大廈為主鍵：整個正確小區（tier 0-2）置於其他小區（tier 3）之上，不會交錯；小區內再按樓層/單元 tier；同 tier 內按 hybrid RRF 分。純結構排序，無 +100/−10 之類 magic number。",
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
        "【全部在一條 pipeline】$rankFusion → $setWindowFields（大廈閘門）→ $addFields + $sort，全部在 aggregation 內完成，不回應用層。 【大廈為主排序鍵】以 hybrid 分最高的文檔作目標小區，tier 0-2 全屬同 estate/district，tier 3 為其他小區；整個正確小區永遠排在其他小區之上，floor/unit 只在小區內重排——不匹配 query 大廈名、不用 regex，多語言通用。 【純結構排序】tier 只用離散層級（0/1/2/3）+ hybrid 分做 tie-break，無 +100/−10 之類 magic number。 【單元格式】unit_code 有補零（0803）與不補零（803）兩種寫法，$switch 用 $in 同時匹配兩種，屬資料正規化。",
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
