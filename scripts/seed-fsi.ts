// ===========================================================================
// FSI EXPANSION — FSI (Funding Reach address verification) demo seed.
//
// Dataset: MAINLAND CHINA addresses, SIMPLIFIED CHINESE first. Designed to
// stress-test MongoDB hybrid (lexical + vector) search on HARD, confusable
// address pairs — the whole point is to surface accuracy edge cases.
//
// Documents go into the SAME `chunks` collection as property data, isolated by
// `metadataType: "fsi"`. `chunkText` == `raw_address` so the EXISTING embedding
// pipeline + vector/lexical indexes apply unchanged. This script only ever
// touches metadataType="fsi" docs, so it is safe to re-run.
//
// -------------------------------------------------------------------------
// CONFUSION AXES intentionally injected (see SUMMARY printed at the end):
//   A. 相近座号  : 1座 / 1A座 / A1座 / 甲座 / 1栋   (same estate, different tower)
//   B. 同楼多层  : same tower on 5/8/15/18/… floors (geo identical, floor differs)
//   C. 近似楼层  : 15 vs 18 vs 51 (digit-similar), 8 vs 18
//   D. 室号前缀  : 0501 / 0801 / 1801 (floor-prefixed unit codes collide)
//   E. 写法变体  : 8楼 / 八楼 / 第8层 / 8F ; 1号楼 / 1栋 / 1座 ; 室 / 号 / 单元
//   F. 座层交叉  : "1座8楼" vs "8座1楼" (same digits, swapped roles)
//   G. 同名跨城  : identical estate name in different cities (text near, geo far)
// -------------------------------------------------------------------------
//
// Usage:
//   npx tsx scripts/seed-fsi.ts            # (re)load FSI data
//   npx tsx scripts/seed-fsi.ts --purge    # clear FSI docs, then reseed
// ===========================================================================

import "./_loadEnv";
import { getCollection } from "../src/lib/mongo";
import { env, hasVoyage, hasMultimodalEmbed } from "../src/lib/env";
import { voyageEmbed, voyageEmbedMultimodal } from "../src/lib/voyage";
import type { ChunkDoc } from "../src/lib/mongo";

// --- Tower model ------------------------------------------------------------
// `code`  : canonical tower code stored in `block` (e.g. "1A")
// `zhForms`: the DIFFERENT simplified-Chinese ways this tower is written. Each
//            form becomes address variants so lexical/vector search must learn
//            they refer to the SAME tower — while NOT collapsing 1座 vs 1A座.
interface Tower {
  code: string;
  zhForms: string[];
}

interface BuildingSpec {
  key: string;
  estateZh: string; // 小区 / 大厦名
  estateEn: string;
  cityZh: string;
  districtZh: string;
  streetZh: string;
  towers: Tower[];
  floors: number[];
  /** unit "seed" numbers within a floor, e.g. 01,02 -> combined with floor. */
  unitSlots: string[];
  coordinates: [number, number]; // [lng, lat]
  /**
   * Unit-code format:
   *  "pad2" (default) -> floor padded to 2 digits: floor 8 + "01" = "0801"
   *  "raw"            -> floor as-is + slot:       floor 8 + "01" = "801"
   * The customer's reported example uses the "raw" form (…6栋801).
   */
  unitFormat?: "pad2" | "raw";
}

const BUILDINGS: BuildingSpec[] = [
  // ---- 深圳 万科城：座号高度相近 (A) + 座层交叉 (F) ----
  {
    key: "vanke-sz",
    estateZh: "万科城",
    estateEn: "Vanke City",
    cityZh: "深圳市",
    districtZh: "龙岗区",
    streetZh: "坂雪岗大道",
    towers: [
      { code: "1", zhForms: ["1座", "1栋", "1号楼"] },
      { code: "1A", zhForms: ["1A座", "1A栋"] },
      { code: "A1", zhForms: ["A1座", "A1栋"] },
      { code: "甲", zhForms: ["甲座", "甲栋"] },
      { code: "8", zhForms: ["8座", "8栋", "8号楼"] },
    ],
    floors: [5, 8, 15, 18],
    unitSlots: ["01", "02"],
    coordinates: [114.06667, 22.68611],
  },
  // ---- 上海 中海国际：写法变体 (E) + 近似楼层 (C) ----
  {
    key: "zhonghai-sh",
    estateZh: "中海国际社区",
    estateEn: "Zhonghai International",
    cityZh: "上海市",
    districtZh: "浦东新区",
    streetZh: "杨高南路",
    towers: [
      { code: "3", zhForms: ["3号楼", "3栋", "3座"] },
      { code: "3B", zhForms: ["3B号楼", "3B栋"] },
    ],
    floors: [8, 15, 18, 51],
    unitSlots: ["01", "03"],
    coordinates: [121.53389, 31.22222],
  },
  // ---- 北京 保利中心：室号前缀碰撞 (D) ----
  {
    key: "poly-bj",
    estateZh: "保利国际中心",
    estateEn: "Poly International Center",
    cityZh: "北京市",
    districtZh: "朝阳区",
    streetZh: "东三环北路",
    towers: [{ code: "2", zhForms: ["2座", "2号楼"] }],
    floors: [5, 8, 18],
    unitSlots: ["01", "02"],
    coordinates: [116.46389, 39.92389],
  },
  // ---- 客户复现用例 (H)：同市同路同小区同栋，只差楼层/室号 ----
  // 精确对应客户报告的 symptom：搜索 "…翠湖花园6栋801" 时，801/501/803 穿插。
  // 6栋只有 1 座 (6)，楼层 5/8/18，每层 slot 01/03 -> 生成 501/503/801/803/1801/1803。
  {
    key: "cuihu",
    estateZh: "翠湖花园",
    estateEn: "Cuihu Garden",
    cityZh: "杭州市",
    districtZh: "西湖区",
    streetZh: "文一西路2002号",
    towers: [{ code: "6", zhForms: ["6栋", "6座", "6号楼"] }],
    floors: [5, 8, 18],
    unitSlots: ["01", "03"],
    coordinates: [120.08833, 30.28889],
    unitFormat: "raw", // -> 501/503/801/803/1801/1803 (matches customer example)
  },
  // ---- 广州 万科城：与深圳万科城同名跨城 (G) ----
  {
    key: "vanke-gz",
    estateZh: "万科城",
    estateEn: "Vanke City",
    cityZh: "广州市",
    districtZh: "番禺区",
    streetZh: "亚运大道",
    towers: [
      { code: "1", zhForms: ["1座", "1栋"] },
      { code: "1A", zhForms: ["1A座"] },
    ],
    floors: [8, 18],
    unitSlots: ["01"],
    coordinates: [113.38472, 22.94167],
  },
];

// --- Floor / unit rendering helpers ----------------------------------------
const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
/** Chinese-numeral floor: 8->八, 15->十五, 18->十八, 51->五十一. */
function cnFloor(n: number): string {
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return "十" + (n % 10 ? CN_DIGITS[n % 10] : "");
  const tens = Math.floor(n / 10);
  return CN_DIGITS[tens] + "十" + (n % 10 ? CN_DIGITS[n % 10] : "");
}

/** Floor-prefixed unit code. pad2: floor 8 -> "0801"; raw: floor 8 -> "801". */
function unitCode(floor: number, slot: string, fmt: "pad2" | "raw" = "pad2"): string {
  const f = fmt === "raw" ? String(floor) : String(floor).padStart(2, "0");
  return `${f}${slot}`;
}

/** ~1m jitter so units of one building share near-identical coordinates. */
function jitter(base: number, seed: number): number {
  return base + ((seed % 7) - 3) * 0.000012;
}

/**
 * Generate several simplified-Chinese writing variants for ONE concrete unit
 * (same city/estate/tower/floor/unit), so search must treat them as the same
 * place. Uses the tower's zhForms to also exercise tower-code variants (axis A).
 */
function addressVariants(
  b: BuildingSpec,
  tower: Tower,
  floor: number,
  unit: string
): string[] {
  const base = `${b.cityZh}${b.districtZh}${b.streetZh}${b.estateZh}`;
  const towerForm = tower.zhForms[0];
  const towerAlt = tower.zhForms[1] ?? tower.zhForms[0];
  return [
    // 标准: 8楼 + 室
    `${base}${towerForm}${floor}楼${unit}室`,
    // 变体: 第8层 + 号 (axis E)
    `${base}${towerAlt}第${floor}层${unit}号`,
    // 中文数字楼层 + 单元 (axis E)
    `${base}${towerForm}${cnFloor(floor)}楼${unit}单元`,
    // 简写/表单风格: estate 座-楼-室 (axis E, terse)
    `${b.estateZh}${tower.code}座-${floor}F-${unit}`,
  ];
}

async function main() {
  const purge = process.argv.includes("--purge");
  const col = await getCollection();

  const records: ChunkDoc[] = [];
  // stats accumulators for the final summary
  let variantCount = 0;
  const perBuilding: Record<string, number> = {};
  const towerCodes = new Set<string>();
  const floorSet = new Set<number>();

  for (const b of BUILDINGS) {
    let seed = 0;
    perBuilding[b.key] = 0;
    for (const tower of b.towers) {
      towerCodes.add(`${b.key}:${tower.code}`);
      for (const floor of b.floors) {
        floorSet.add(floor);
        for (const slot of b.unitSlots) {
          const unit = unitCode(floor, slot, b.unitFormat ?? "pad2");
          const variants = addressVariants(b, tower, floor, unit);
          const coord: [number, number] = [
            jitter(b.coordinates[0], seed),
            jitter(b.coordinates[1], seed + 1),
          ];
          seed += 1;
          variants.forEach((raw, vi) => {
            variantCount += 1;
            perBuilding[b.key] += 1;
            const docId = `fsi-${b.key}-${tower.code}-${floor}-${unit}-v${vi}`;
            records.push({
              _id: docId,
              docId,
              docType: "fsi_address",
              title: raw,
              propertyName: b.estateZh,
              propertyAliases: [b.estateEn, `${b.cityZh}${b.estateZh}`],
              segment: "fsi",
              language: ["zh"],
              tags: ["fsi", "address", b.key, b.cityZh],
              exactTerms: [
                b.estateZh,
                tower.code,
                `${floor}楼`,
                `${unit}室`,
                b.cityZh,
              ],
              sourceText: raw,
              chunkText: raw, // embedded by existing pipeline
              chunkIndex: vi,
              updatedAt: new Date().toISOString(),
              // ---- FSI structured fields ----
              metadataType: "fsi",
              raw_address: raw,
              district: `${b.cityZh}${b.districtZh}`,
              estate: b.estateZh,
              block: tower.code,
              floor_num: floor,
              unit_code: unit,
              building_name: `${b.cityZh}${b.estateZh}${tower.zhForms[0]}`,
              location: { type: "Point", coordinates: coord },
            });
          });
        }
      }
    }
  }

  console.log(`Prepared ${records.length} FSI address documents.`);

  // Embeddings — identical strategy to the property seed.
  if (env.embeddingStrategy === "atlas") {
    console.log(
      "EMBEDDING_STRATEGY=atlas -> Atlas Auto Embedding embeds 'chunkText'. No local embedding."
    );
  } else if (hasVoyage()) {
    console.log(`Generating Voyage embeddings (${env.voyageEmbedModel})...`);
    const bs = 32;
    for (let i = 0; i < records.length; i += bs) {
      const batch = records.slice(i, i + bs);
      const vectors = await voyageEmbed(
        batch.map((r) => r.chunkText),
        "document"
      );
      batch.forEach((r, j) => (r.embedding = vectors[j]));
      console.log(`  embedded ${Math.min(i + bs, records.length)}/${records.length}`);
    }
  } else {
    console.warn("WARNING: no embeddings generated (VOYAGE_API_KEY unset & strategy!=atlas).");
  }

  if (hasMultimodalEmbed() && records.length) {
    console.log(`Generating multimodal embeddings (${env.multimodalEmbedModel})...`);
    const bs = 32;
    for (let i = 0; i < records.length; i += bs) {
      const batch = records.slice(i, i + bs);
      const vectors = await voyageEmbedMultimodal(
        batch.map((r) => r.chunkText),
        "document"
      );
      batch.forEach((r, j) => ((r as any).embeddingMultimodal = vectors[j]));
      console.log(`  mm-embedded ${Math.min(i + bs, records.length)}/${records.length}`);
    }
  }

  // Reset ONLY the FSI dataset.
  const del = await col.deleteMany({ metadataType: "fsi" });
  console.log(`Removed ${del.deletedCount} existing FSI docs.`);
  if (purge) console.log("--purge: FSI docs cleared before reseeding.");
  if (records.length) await col.insertMany(records as any);

  // ---- Distribution summary ----
  console.log("\n================ FSI TEST DATA SUMMARY ================");
  console.log(`总文档数 total docs            : ${records.length}`);
  console.log(`大厦/小区 buildings            : ${BUILDINGS.length}`);
  console.log(`座/栋 towers (across all)      : ${towerCodes.size}`);
  console.log(`楼层集合 distinct floors        : ${[...floorSet].sort((a, b) => a - b).join(", ")}`);
  console.log(`每条真实单元的写法变体 variants  : 4`);
  console.log("\n每栋文档分布 per-building docs:");
  for (const b of BUILDINGS) {
    console.log(
      `  ${b.cityZh}${b.estateZh} (${b.key}): ${perBuilding[b.key]} docs, ` +
        `towers=[${b.towers.map((t) => t.code).join(",")}], floors=[${b.floors.join(",")}]`
    );
  }
  console.log("\n注入的混淆维度 confusion axes:");
  console.log("  A 相近座号: 1座/1A座/A1座/甲座/1栋 (deep,sz-vanke)");
  console.log("  B 同楼多层: same tower on 5/8/15/18 floors");
  console.log("  C 近似楼层: 15 vs 18 vs 51 (sh-zhonghai)");
  console.log("  D 室号前缀: 0501/0801/1801 floor-prefixed unit codes");
  console.log("  E 写法变体: 8楼/八楼/第8层/8F, 室/号/单元, 座/栋/号楼");
  console.log("  F 座层交叉: 1座8楼 vs 8座1楼 (same digits, swapped)");
  console.log("  G 同名跨城: 万科城 in 深圳 vs 广州 (text near, geo far)");
  console.log("=======================================================\n");
  console.log("Property dataset untouched.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
