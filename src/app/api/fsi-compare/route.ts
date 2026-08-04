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
} from "@/lib/retrieval";
import { parseAddressQuery, floorAwareRerank } from "@/lib/floorRank";
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
  const unit = parsed.unit ?? "<未解析>";
  return `// ── 步驟 1：標準 hybrid 檢索（大廈／地址語義由此理解，不匹配大廈名、不用 regex、多語言通用）──
[
  {
    "$rankFusion": {                          // 官方 stage：MongoDB 8.0+ 原生混合檢索
      "input": {
        "pipelines": {                        // $rankFusion 內部欄位（非 operator）
          "vector": [                         // 向量檢索通路（pipeline 名稱自訂）
            { "$vectorSearch": {
              "index": ${JSON.stringify(env.vectorIndex)},
              "path": "chunkText",
              "query": ${q},
              "numCandidates": 150,
              "limit": ${pool},
              "filter": { "metadataType": "fsi" }
            } }
          ],
          "lexical": [                        // 詞法檢索通路（pipeline 名稱自訂）
            { "$search": { /* compound BM25 over chunkText / title / exactTerms … */ } },
            { "$match": { "metadataType": "fsi" } },
            { "$limit": ${pool} }
          ]
        }
      },
      "combination": { "weights": { "vector": 1, "lexical": 1 } }  // 只有兩條通路；無樓層通路
    }
  },
  { "$limit": ${pool} }
]
// ↑ hybrid 返回的候選集「已經是正確大廈」——樓層／單元不參與檢索。

// ── 步驟 2：在候選集之上，樓層／單元分組置頂（應用層，純結構排序，非 DB stage）──
parseAddressQuery(${q})  →  { floor: ${floor}, unit: ${JSON.stringify(unit)} }
stableRegroup(候選集, floor, unit):
   tier 0  →  floor_num == ${floor} 且 unit == ${JSON.stringify(unit)}   // 目標房間
   tier 1  →  floor_num == ${floor}                                      // 同樓層鄰居
   tier 2  →  其餘
   // 組內保留 hybrid 原排名（JS 穩定排序）作 tie-break
   // 無 +100/−10 之類 magic number；不重新檢索；不碰大廈名`;
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

    // Floor/unit re-rank ON TOP OF the hybrid candidate set (customer's design):
    // building understood by hybrid; floor/unit only stably re-group the result.
    const regrouped = floorAwareRerank(hyb, query);
    const nativeFloor = regrouped.hits;

    const hybridExplain = explainForMode("hybrid", query, Math.max(limit, 12), {});
    const nativeExplain = {
      mode: "floor-regroup",
      title: "Hybrid + 樓層/單元置頂（候選集之上再排序）",
      features: [
        {
          name: "① Hybrid search（$rankFusion：向量 + 詞法）",
          detail:
            "先跑標準 hybrid 檢索。大廈／地址語義完全由 hybrid 理解——不匹配大廈名、不用 regex，天然支援多語言。返回的候選集已是正確大廈。",
        },
        {
          name: "② 樓層／單元分組置頂（候選集之上，純結構排序）",
          detail: `在 hybrid 候選集之上，把 floor_num = ${parsed.floor ?? "?"}（且 unit = ${parsed.unit ?? "?"}）的文檔穩定置頂。分三層：精確樓層+單元 → 精確樓層 → 其餘。組內保留 hybrid 原排名作 tie-break。無任何加分數字 / magic number，不重新檢索。`,
        },
      ],
      stages: [
        {
          label: "① Hybrid 檢索 — $rankFusion（向量 + 詞法）",
          collection: `${env.dbName}.${env.collectionName}`,
          pipeline: hybridExplain.stages[0]?.pipeline ?? [],
          annotatedPipeline: buildAnnotatedFloorPipeline(
            query,
            parsed,
            Math.max(limit, 12)
          ),
        },
        {
          label: "② 樓層／單元分組置頂（應用層，非 DB stage）",
          collection: "(in-app · 純結構排序)",
          pipeline: [
            {
              parseAddressQuery: {
                input: query,
                output: { floor: parsed.floor ?? null, unit: parsed.unit ?? null },
              },
            },
            {
              stableRegroup: {
                tier0: "floor_num == 查詢樓層 且 unit == 查詢單元",
                tier1: "floor_num == 查詢樓層",
                tier2: "其餘",
                tieBreak: "組內保留 hybrid 原排名（穩定排序）",
              },
            },
          ],
        },
      ],
      annotations: [
        {
          token: "① $rankFusion（hybrid）",
          kind: "官方 stage",
          detail:
            "標準 hybrid 檢索：$rankFusion 融合向量 + 詞法兩條子管線。大廈／地址語義由此理解——不匹配大廈名、不用 regex、天然多語言。它返回的候選集已是正確大廈。",
        },
        {
          token: "② parseAddressQuery + stableRegroup",
          kind: "應用層邏輯（非 DB stage）",
          detail:
            "在 hybrid 候選集之上進行。先從查詢解析樓層／單元，再把候選穩定分三層置頂（精確樓層+單元 → 精確樓層 → 其餘）。不重新檢索、不碰大廈名。",
        },
        {
          token: "純結構排序（無 magic number）",
          kind: "設計原則",
          detail:
            "分組只用離散層級（tier 0/1/2），組內用 JS 穩定排序保留 hybrid 原名次作 tie-break。沒有 +100 / −10 之類加分數字，也沒有樓層距離運算。",
        },
      ],
      notes:
        "【為何這樣設計】樓層／單元只是「hybrid 候選集之上的再排序」，不是獨立檢索通路。大廈由 hybrid（向量語義 + 詞法）自己理解，因此不需要匹配大廈名、不用 regex，換成其他 entity 或多語言地址一樣可用。舊版把樓層／單元做成獨立 $rankFusion 通路（全 collection $match 同樓層／同單元）是錯的：它會投票給其他大廈的同樓層文檔，令「翠湖花園」這種關鍵字被忽略。 【純結構排序】置頂只用離散層級 + 穩定排序，組內保留 hybrid 原排名，無任何 magic number。 【單元格式】unit_code 有補零（0803）與不補零（803）兩種寫法，比較時做正規化（去前導零），屬資料正規化、非排序權重。",
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
