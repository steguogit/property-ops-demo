// ===========================================================================
// FSI EXPANSION — Industry mode configuration.
//
// Single source of truth for the two dataset "modes" the demo supports:
//   - "property" : the original Property Management Assistant
//   - "fsi"      : FSI Funding Reach address verification (geo + vector)
//
// Documents are physically co-located in the same `chunks` collection but are
// isolated by the `metadataType` field (== the mode). All mode-specific chrome
// (titles, placeholders, field labels) is driven from here so the rest of the
// app stays generic.
// ===========================================================================

export type IndustryMode = "property" | "fsi";

export const INDUSTRY_MODES: IndustryMode[] = ["property", "fsi"];

/** The DB marker written on every document, keyed by mode. */
export const METADATA_TYPE: Record<IndustryMode, string> = {
  property: "property",
  fsi: "fsi",
};

/** Default mode when none is supplied (backwards-compatible with existing data). */
export const DEFAULT_MODE: IndustryMode = "property";

export function isIndustryMode(v: unknown): v is IndustryMode {
  return v === "property" || v === "fsi";
}

/** Coerce an arbitrary value to a valid mode (falls back to the default). */
export function coerceMode(v: unknown): IndustryMode {
  return isIndustryMode(v) ? v : DEFAULT_MODE;
}

interface IndustryConfig {
  /** Short switcher label. */
  switchLabel: string;
  /** Header main title. */
  title: string;
  /** Header tagline / subtitle. */
  tagline: string;
  /** Search box placeholder. */
  searchPlaceholder: string;
  /** Whether this mode uses geo + floor-aware ranking (FSI). */
  geoFloorRanking: boolean;
}

/**
 * Presentational config per mode. English + Traditional Chinese. The UI reads
 * this via useIndustry(); the i18n dictionary stays for generic chrome.
 */
export const INDUSTRY_CONFIG: Record<
  IndustryMode,
  { en: IndustryConfig; zh: IndustryConfig }
> = {
  property: {
    en: {
      switchLabel: "Property Management",
      title: "Property Operations Assistant",
      tagline:
        "MongoDB Atlas retrieval lab — Vector vs Hybrid vs Reranked, with grounded RAG",
      searchPlaceholder: "Ask an operations question in English or Chinese…",
      geoFloorRanking: false,
    },
    zh: {
      switchLabel: "物業管理",
      title: "物業營運助理",
      tagline:
        "MongoDB Atlas 檢索實驗室 — 向量 / 混合 / 重新排序比較，並提供有依據的 RAG",
      searchPlaceholder: "以中文或英文輸入營運問題…",
      geoFloorRanking: false,
    },
  },
  fsi: {
    en: {
      switchLabel: "FSI Funding Address Verification",
      title: "FSI Funding Reach — Address Verification",
      tagline: "Geo + Vector Hybrid Search · MongoDB Atlas",
      searchPlaceholder:
        "Enter an address to verify (e.g. Flat A, 8/F, Block 2, ICC…)",
      geoFloorRanking: true,
    },
    zh: {
      switchLabel: "金融地址核驗",
      title: "FSI Funding Reach — 地址核驗",
      tagline: "Geo + 向量混合檢索 · MongoDB Atlas",
      searchPlaceholder: "輸入要核驗的地址（例如：環球貿易廣場 2座 8樓 A室）…",
      geoFloorRanking: true,
    },
  },
};

/** FSI-specific structured field labels (for detail views / result cards). */
export const FSI_FIELD_LABELS: Record<string, { en: string; zh: string }> = {
  raw_address: { en: "Raw address", zh: "原始地址" },
  district: { en: "District", zh: "行政區" },
  estate: { en: "Estate / Building", zh: "屋苑／大廈" },
  block: { en: "Block", zh: "座號" },
  floor_num: { en: "Floor", zh: "樓層" },
  unit_code: { en: "Unit", zh: "單位" },
  building_name: { en: "Full building name", zh: "完整大廈名" },
};
