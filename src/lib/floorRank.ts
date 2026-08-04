// ===========================================================================
// FSI EXPANSION — Floor-aware re-ranking (Phase 4 core, demo).
//
// PROBLEM (reproduced): pure vector / hybrid search orders near-duplicate
// addresses (same building, adjacent floors) only by semantic score. Because
// "801" vs "803" vs "501" differ by ~0.4% cosine, floors interleave (e.g.
// 801, 501, 803). Vector search does not understand numeric floor proximity.
//
// FIX (post-retrieval, no index rebuild): parse the query's intended floor +
// unit, then re-rank the SAME candidate pool with a structured boost:
//   - exact floor match  -> strong boost (forces same-floor to the top)
//   - exact unit match    -> extra boost (the queried unit itself first)
//   - otherwise           -> penalty proportional to |floor - queryFloor|
// The base semantic score is kept as a tie-breaker within a floor group.
//
// This is intentionally simple/deterministic so the demo can show
// "baseline vs floor-aware" on identical candidates. No model needed.
// ===========================================================================

export interface ParsedAddressQuery {
  /** Numeric floor parsed from the query, if any. */
  floor?: number;
  /** Unit/room code parsed from the query (digits), if any. */
  unit?: string;
}

const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** Convert a Chinese-numeral floor string (八, 十五, 五十一) to a number. */
function cnNumToInt(s: string): number | undefined {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // handle 十, 十X, X十, X十X
  if (s === "十") return 10;
  const shiIdx = s.indexOf("十");
  if (shiIdx === -1) {
    // single digit like 八
    const d = CN_NUM[s];
    return d != null ? d : undefined;
  }
  const tensChar = s.slice(0, shiIdx);
  const onesChar = s.slice(shiIdx + 1);
  const tens = tensChar ? CN_NUM[tensChar] ?? 1 : 1;
  const ones = onesChar ? CN_NUM[onesChar] ?? 0 : 0;
  return tens * 10 + ones;
}

/**
 * Parse floor + unit from a free-form Chinese/mixed address query.
 * Handles: 8楼 / 八楼 / 第8层 / 第八层 / 8F  and  801室 / 801号 / 801单元 / 801.
 */
export function parseAddressQuery(q: string): ParsedAddressQuery {
  const out: ParsedAddressQuery = {};

  // Floor: 数字 or 中文数字 followed by 楼/层/F, optional 第 prefix.
  const floorMatch =
    q.match(/第?\s*(\d{1,3})\s*(?:楼|樓|层|層)/) ||
    q.match(/(\d{1,3})\s*[Ff](?![A-Za-z])/) ||
    q.match(/第?\s*([零一二两三四五六七八九十]{1,3})\s*(?:楼|樓|层|層)/);
  if (floorMatch) {
    const n = cnNumToInt(floorMatch[1]);
    if (n != null && n > 0) out.floor = n;
  }

  // Unit: prefer a trailing 3-4 digit group (the actual room), then a group
  // explicitly tagged 室/单元 (NOT 号 alone — street numbers use 号, e.g. 2002号).
  // We scan for the LAST match so street numbers earlier in the string lose.
  const trailing = q.match(/(\d{3,4})\s*$/);
  const tagged = [...q.matchAll(/(\d{3,4})\s*(?:室|單元|单元)/g)];
  if (trailing) out.unit = trailing[1];
  else if (tagged.length) out.unit = tagged[tagged.length - 1][1];

  // If we have a unit like "801" but no explicit floor, infer floor from the
  // leading digit(s): 801 -> 8, 1801 -> 18, 501 -> 5.
  if (out.floor == null && out.unit) {
    const u = out.unit;
    const inferred = u.length === 4 ? parseInt(u.slice(0, 2), 10) : parseInt(u.slice(0, 1), 10);
    if (inferred > 0) out.floor = inferred;
  }

  return out;
}
