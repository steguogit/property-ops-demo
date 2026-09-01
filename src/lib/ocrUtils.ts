import { env } from "./env";

// ---------------------------------------------------------------------------
// External PaddleOCR utilities (backend-separated OCR).
//
// These helpers let the Node app delegate OCR to the standalone Python
// PaddleOCR microservice (./ocr-service) and fix the reading order of mixed
// horizontal + vertical handwritten forms BEFORE the text is embedded.
//
// Nothing here touches MongoDB or embeddings — it only turns an image into an
// ordered block list + a fullText string. Persistence + embedding stay in the
// existing ingest.ts / extract.ts pipeline.
//
//   callExternalOcrService(buffer)  -> OcrBlock[]        (HTTP call, with fallback)
//   reorderOcrBlocks(blocks)        -> OcrBlock[]        (mixed-orientation sort)
//   buildFullTextFromBlocks(sorted) -> string           (embedding-ready text)
// ---------------------------------------------------------------------------

/** A single OCR block as returned by the PaddleOCR microservice. */
export interface OcrBlock {
  /** 4-point polygon [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]. */
  bbox: [number, number][];
  /** Layout orientation derived from the bbox geometry. */
  direction: "vertical" | "horizontal";
  /**
   * Text-line inclination in degrees (0 = horizontal, ~90 = vertical/rotated).
   * Reported by the OCR service; used to flag rotated handwritten-name blocks.
   * Optional for backwards compatibility with older service builds.
   */
  angle?: number;
  text: string;
  confidence: number;
  /**
   * True once this block has been re-read by the multimodal handwriting pass.
   * `text` is then the model's transcription (or the illegible placeholder).
   */
  handwritten?: boolean;
}

/** A recognised handwritten name, stored at the document top level. */
export interface HandwrittenName {
  /** The transcribed name (or the illegible placeholder). */
  nameText: string;
  /** Detected script of the name. */
  lang: "zh" | "en" | "mixed" | "unknown";
  /** bbox of the source block (pixel polygon), preserved even when illegible. */
  bbox: [number, number][];
  /** OCR confidence of the ORIGINAL printed pass (pre re-read). */
  sourceConfidence: number;
}

/** Placeholder written into a block when handwriting is genuinely illegible. */
export const HANDWRITING_ILLEGIBLE = "[無法識別手寫姓名]";

/**
 * Result of running external OCR on one image: the raw (unsorted) blocks as the
 * service returned them, and the reorder-then-join fullText used for embedding.
 * `usedExternal` is false when we fell back to the local OCR implementation.
 */
export interface ExternalOcrResult {
  blocks: OcrBlock[];
  fullText: string;
  usedExternal: boolean;
  ocrVersion: string;
  note?: string;
  /**
   * Handwritten names recovered by the multimodal re-read of candidate blocks.
   * Empty when no candidates were found or the handwriting pass is disabled.
   */
  handwrittenNames?: HandwrittenName[];
}

export const OCR_VERSION_EXTERNAL = "paddle_layout_v1";

/** Signature for the local OCR fallback (injected to avoid an import cycle). */
export type LocalOcrFallback = (
  buffer: Buffer,
  mimeType?: string
) => Promise<string>;

/**
 * Signature for the multimodal handwritten-name pass (injected to avoid an
 * import cycle with handwriting.ts). Mutates `blocks` in place (back-filling
 * candidate text) and returns the recognised names.
 */
export type HandwritingPass = (
  imageBuffer: Buffer,
  blocks: OcrBlock[]
) => Promise<HandwrittenName[]>;

/** Compute the geometric center (cx, cy) of a block's bbox. */
function blockCenter(block: OcrBlock): { cx: number; cy: number } {
  const xs = block.bbox.map((p) => p[0]);
  const ys = block.bbox.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { cx, cy };
}

/**
 * Reorder OCR blocks into the correct human reading order for a document that
 * MIXES horizontal and vertical text — the core fix for scrambled handwriting.
 *
 * Strategy:
 *   - VERTICAL blocks (traditional Chinese columns) read right-to-left, so we
 *     sort by cx DESCENDING (right column first); within the same column, top to
 *     bottom (cy ascending).
 *   - HORIZONTAL blocks read top-to-bottom, left-to-right, so we sort by cy
 *     ascending, then cx ascending on the same line.
 *   - Vertical blocks are emitted before horizontal blocks so column text stays
 *     contiguous (mixed layouts typically have a vertical block then a
 *     horizontal caption/field rather than interleaving mid-column).
 *
 * "Same column / same line" uses a tolerance proportional to the median block
 * size so minor bbox jitter doesn't flip the ordering.
 */
export function reorderOcrBlocks(blocks: OcrBlock[]): OcrBlock[] {
  if (!blocks || blocks.length <= 1) return blocks ?? [];

  // Tolerance for grouping into the same column (vertical) / line (horizontal).
  const sizes = blocks.map((b) => {
    const xs = b.bbox.map((p) => p[0]);
    const ys = b.bbox.map((p) => p[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  });
  const sorted = [...sizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 20;
  const tol = median * 0.5;

  const withCenter = blocks.map((b) => ({ b, ...blockCenter(b) }));

  const vertical = withCenter.filter((x) => x.b.direction === "vertical");
  const horizontal = withCenter.filter((x) => x.b.direction !== "vertical");

  // Vertical: right-to-left columns (cx DESC), then top-to-bottom within a column.
  vertical.sort((a, b) => {
    if (Math.abs(a.cx - b.cx) > tol) return b.cx - a.cx; // right first
    return a.cy - b.cy; // same column: top first
  });

  // Horizontal: top-to-bottom lines (cy ASC), then left-to-right within a line.
  horizontal.sort((a, b) => {
    if (Math.abs(a.cy - b.cy) > tol) return a.cy - b.cy; // top first
    return a.cx - b.cx; // same line: left first
  });

  return [...vertical, ...horizontal].map((x) => x.b);
}

/**
 * Build the embedding-ready fullText from ALREADY-ORDERED blocks (pass the
 * output of reorderOcrBlocks). One block per line, blanks dropped.
 */
export function buildFullTextFromBlocks(sortedBlocks: OcrBlock[]): string {
  return (sortedBlocks ?? [])
    .map((b) => (b.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Handwritten-name candidate detection — LABEL-ANCHORED.
//
// HK tenancy forms have a FIXED layout: printed field labels (業主 / 租客 /
// 甲方 / 乙方 / 立租約人 / 簽署 / 日期 …) with the tenant/owner's HANDWRITTEN name
// written right next to the label. We DON'T deploy separate zh/en handwriting
// models: PaddleOCR only detects text regions; the name block next to a label
// is re-read by ONE multimodal model (zh / en / mixed automatically).
//
// LESSONS FROM REAL HK FORMS (why NOT angle/confidence/position):
//   - Forms are typeset VERTICALLY -> angle≈90° for the WHOLE page (no signal).
//   - Printed body text is only MEDIUM confidence (0.76–0.89), same as a
//     handwritten name -> a confidence threshold can't separate them.
//   - The top/bottom bands are full of printed body text too -> position alone
//     over-selects.
// The RELIABLE signal is the printed LABEL. So we anchor on labels and take the
// spatially-adjacent block(s) as the handwritten name.
// ---------------------------------------------------------------------------

/**
 * Printed field labels that precede a handwritten name on HK tenancy forms.
 * Includes OCR variants: 業 is often read as the simplified/degraded glyph 业.
 */
export const NAME_FIELD_LABELS = [
  "業主",
  "业主",
  "業",
  "业",
  "租客",
  "甲方",
  "乙方",
  "立租約人",
  "簽署",
  "簽名",
  "簽收",
  "租客簽署",
  "業主簽署",
  "承租人",
  "出租人",
];

/** Kept for backwards-compat / tuning. */
export const HANDWRITING_CONF_MAX = 0.6;

/** Axis-aligned bounds of a block's bbox. */
function blockBounds(b: OcrBlock): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const xs = b.bbox.map((p) => p[0]);
  const ys = b.bbox.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/**
 * Normalised text for label matching: strip spaces and the punctuation OCR uses
 * (interchangeably) for the field separator — colon : ： and semicolon ; ；
 * (PaddleOCR frequently mis-reads the field colon as a semicolon).
 */
function normLabel(t: string): string {
  return (t ?? "").replace(/[\s:：;；]/g, "").trim();
}

/** Is a block a printed field label (業主 / 租客 / 立租約人 …)? */
function isFieldLabel(block: OcrBlock): boolean {
  const t = normLabel(block.text);
  if (!t) return false;
  // A label is short and matches one of the known field labels (allowing the
  // label to be embedded, e.g. OCR merged "業：陈藝森" — handled by the caller).
  return NAME_FIELD_LABELS.some((lab) => {
    const l = normLabel(lab);
    return t === l;
  });
}

/**
 * Some OCR reads merge the label AND the handwritten name into one block, e.g.
 * "業主：陈藝森" or "租客:劉劍舞". Detect that case and return the name portion so
 * the block itself becomes a candidate (its own text is corrected in place).
 */
function labelPrefixName(block: OcrBlock): string | null {
  const raw = (block.text ?? "").trim();
  // Require a COLON after the label — printed body sentences ("租客不得分租…")
  // have no colon, so they are not mistaken for a "label: name" field. The name
  // portion must be SHORT (a name, not a clause): <= 12 chars after the colon.
  // Accept colon OR semicolon (OCR mis-reads the field colon as ；/;).
  const m = raw.match(
    /^(業主|业主|業|业|租客|甲方|乙方|承租人|出租人|立租約人)\s*[:：;；]\s*(.+)$/
  );
  if (m && m[2]) {
    const name = m[2].trim();
    const n = normLabel(name).length;
    if (n >= 1 && n <= 12) return name;
  }
  return null;
}

/**
 * LABEL-ANCHORED candidate detection.
 *
 * Returns the indices of blocks that hold a handwritten name, found by:
 *   1. any block that MERGES a label + name ("業主：陈藝森") — the block itself, and
 *   2. for each printed label block (業主/租客/…), the nearest block to its
 *      RIGHT (vertical forms read right-to-left, name is the next column) or
 *      BELOW/AFTER it, that is not itself a label.
 *
 * This is robust on fully-vertical HK forms where angle/confidence/position
 * carry no signal.
 */
export function findHandwrittenNameCandidates(blocks: OcrBlock[]): number[] {
  if (!blocks || !blocks.length) return [];
  const bounds = blocks.map((b, i) => ({ i, ...blockBounds(b) }));
  const picked = new Set<number>();

  // Median size -> neighbour search radius.
  const sizes = bounds.map((b) => Math.max(b.maxX - b.minX, b.maxY - b.minY));
  const med = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] || 20;
  const radius = med * 4;

  for (let i = 0; i < blocks.length; i++) {
    // Case 1: label + name merged in one block.
    if (labelPrefixName(blocks[i]) && !isFieldLabel(blocks[i])) {
      picked.add(i);
      continue;
    }
    if (!isFieldLabel(blocks[i])) continue;

    // Case 2: find the nearest non-label block adjacent to this label. Vertical
    // HK forms put the handwritten name in the column immediately to the LEFT or
    // RIGHT of the label, roughly at the same vertical position.
    const lb = bounds[i];
    const lcx = (lb.minX + lb.maxX) / 2;
    const lcy = (lb.minY + lb.maxY) / 2;
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < blocks.length; j++) {
      if (j === i || isFieldLabel(blocks[j])) continue;
      // Skip PRINTED BODY TEXT: a long, high-confidence run is a body clause,
      // not a handwritten name. Names are short (<= 6 CJK chars typically).
      if (isPrintedBody(blocks[j])) continue;
      const nb = bounds[j];
      const ncx = (nb.minX + nb.maxX) / 2;
      const ncy = (nb.minY + nb.maxY) / 2;
      // Must be vertically close to the label (same field row/band).
      if (Math.abs(ncy - lcy) > radius) continue;
      const dx = Math.abs(ncx - lcx);
      const dy = Math.abs(ncy - lcy);
      const dist = dx + dy;
      if (dist < bestDist && dist <= radius * 2) {
        bestDist = dist;
        best = j;
      }
    }
    if (best >= 0) picked.add(best);
  }

  return [...picked].sort((a, b) => a - b);
}

/**
 * A block is PRINTED BODY TEXT (not a handwritten name) when it is a long run
 * of text read with decent confidence. Handwritten names are short; body
 * clauses are long. Threshold: > 6 characters AND confidence >= 0.6.
 */
function isPrintedBody(block: OcrBlock): boolean {
  const n = normLabel(block.text).length;
  if (n > 6 && block.confidence >= 0.6) return true;
  // A VERY high-confidence short read is trusted printed text (e.g. a stray
  // printed "租" glyph next to a label), NOT handwriting — handwritten names
  // are never read at ~1.0 confidence. Excludes label-neighbour noise.
  if (block.confidence >= 0.95) return true;
  return false;
}

/** A cluster of adjacent candidate blocks that form ONE handwritten name. */
export interface CandidateCluster {
  /** Indices (into the original blocks array) that make up this cluster. */
  memberIndices: number[];
  /** Union bounding polygon (axis-aligned rectangle as a 4-point polygon). */
  bbox: [number, number][];
  /** Lowest member confidence — the OCR's own doubt about the printed read. */
  minConfidence: number;
}

/**
 * Cluster adjacent candidate blocks so a handwritten name that OCR split into
 * several single-glyph blocks is cropped + re-read as ONE image (single glyphs
 * are unreadable to the vision model). Two candidates join the same cluster
 * when their bounding boxes are within `gap` pixels in BOTH axes (gap scales
 * with the median block size). Greedy union-find style merge.
 */
export function clusterCandidates(
  blocks: OcrBlock[],
  indices: number[]
): CandidateCluster[] {
  if (!indices.length) return [];

  // Median block size -> adjacency gap (names sit close; body text is farther).
  const sizes = indices.map((i) => {
    const { minX, minY, maxX, maxY } = blockBounds(blocks[i]);
    return Math.max(maxX - minX, maxY - minY);
  });
  const med =
    [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] || 20;
  const gap = med * 1.2;

  const bounds = indices.map((i) => ({ i, ...blockBounds(blocks[i]) }));
  // A candidate that ALREADY holds a multi-char name (>= 2 chars) is a complete
  // name on its own and must NOT be merged with neighbours (that would drag in
  // adjacent fields / stray glyphs). Only SINGLE-glyph candidates get merged.
  const isShort = (idx: number) => normLabel(blocks[idx].text).length <= 1;
  const adjacent = (
    a: (typeof bounds)[number],
    b: (typeof bounds)[number]
  ): boolean => {
    if (!isShort(a.i) || !isShort(b.i)) return false;
    const gx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
    const gy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
    return gx <= gap && gy <= gap;
  };

  // Greedy clustering: seed a cluster, absorb any candidate adjacent to ANY
  // current member, repeat until stable.
  const used = new Set<number>();
  const clusters: CandidateCluster[] = [];
  for (let s = 0; s < bounds.length; s++) {
    if (used.has(s)) continue;
    const members = [s];
    used.add(s);
    let grew = true;
    while (grew) {
      grew = false;
      for (let t = 0; t < bounds.length; t++) {
        if (used.has(t)) continue;
        if (members.some((m) => adjacent(bounds[m], bounds[t]))) {
          members.push(t);
          used.add(t);
          grew = true;
        }
      }
    }
    const memberIndices = members.map((m) => bounds[m].i);
    const minX = Math.min(...members.map((m) => bounds[m].minX));
    const minY = Math.min(...members.map((m) => bounds[m].minY));
    const maxX = Math.max(...members.map((m) => bounds[m].maxX));
    const maxY = Math.max(...members.map((m) => bounds[m].maxY));
    const minConfidence = Math.min(
      ...memberIndices.map((i) => blocks[i].confidence)
    );
    clusters.push({
      memberIndices,
      bbox: [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ],
      minConfidence,
    });
  }
  return clusters;
}

/**
 * Convenience: find candidates and cluster them in one call. Returns the
 * clusters (each = one handwritten name to crop + re-read).
 */
export function findHandwrittenNameClusters(
  blocks: OcrBlock[]
): CandidateCluster[] {
  return clusterCandidates(blocks, findHandwrittenNameCandidates(blocks));
}

/** Coerce arbitrary service JSON into a validated OcrBlock[]. */
function normalizeBlocks(raw: unknown): OcrBlock[] {
  const arr = (raw as { blocks?: unknown })?.blocks;
  if (!Array.isArray(arr)) return [];
  const out: OcrBlock[] = [];
  for (const item of arr) {
    const b = item as Partial<OcrBlock>;
    if (!Array.isArray(b.bbox) || typeof b.text !== "string") continue;
    const bbox = (b.bbox as unknown[])
      .map((p) => {
        const pair = p as unknown[];
        return [Number(pair?.[0]) || 0, Number(pair?.[1]) || 0] as [
          number,
          number
        ];
      })
      .slice(0, 4);
    if (bbox.length < 4) continue;
    const direction: OcrBlock["direction"] =
      b.direction === "vertical" ? "vertical" : "horizontal";
    out.push({
      bbox,
      direction,
      angle: typeof b.angle === "number" ? b.angle : undefined,
      text: b.text,
      confidence: typeof b.confidence === "number" ? b.confidence : 0,
    });
  }
  return out;
}

/**
 * Call the external PaddleOCR microservice for one image.
 *
 * - Reads the endpoint from env (`OCR_SERVICE_URL`); never hard-codes a port.
 * - POSTs the image as multipart/form-data (field `file`).
 * - On any network / service error (or when the feature flag is off), falls back
 *   to the supplied local OCR implementation so ingestion never breaks. When
 *   falling back, `blocks` is empty and `usedExternal` is false.
 *
 * Returns raw (unsorted) blocks plus a reordered `fullText` ready for embedding.
 */
export async function callExternalOcrService(
  imageBuffer: Buffer,
  opts: {
    mimeType?: string;
    fileName?: string;
    fallback?: LocalOcrFallback;
    /**
     * Optional multimodal handwritten-name pass. When supplied, candidate
     * blocks (rotated / low-confidence names in the signature region) are
     * cropped and re-read by a single multimodal model, back-filling their
     * `text` BEFORE reordering so the corrected names feed the embedding.
     */
    handwritingPass?: HandwritingPass;
  } = {}
): Promise<ExternalOcrResult> {
  const { mimeType, fileName, fallback, handwritingPass } = opts;

  const doFallback = async (note: string): Promise<ExternalOcrResult> => {
    let text = "";
    if (fallback) {
      try {
        text = (await fallback(imageBuffer, mimeType)) || "";
      } catch (e) {
        note += ` | local fallback also failed: ${(e as Error).message}`;
      }
    }
    return {
      blocks: [],
      fullText: text.trim(),
      usedExternal: false,
      ocrVersion: "local_fallback",
      note,
    };
  };

  const url = env.ocrServiceUrl;
  if (!url) return doFallback("OCR_SERVICE_URL not configured");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    env.ocrServiceTimeoutMs
  );
  try {
    const form = new FormData();
    const type = mimeType || "image/png";
    // Copy into a fresh Uint8Array so the Blob part is a plain ArrayBuffer view
    // (Node Buffers can be backed by SharedArrayBuffer, which BlobPart rejects).
    const bytes = new Uint8Array(imageBuffer);
    const blob = new Blob([bytes], { type });
    form.append("file", blob, fileName || "upload.png");

    const res = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      return doFallback(`OCR service ${res.status}: ${body}`);
    }
    const json = await res.json();
    const blocks = normalizeBlocks(json);

    // Multimodal handwritten-name pass: re-read candidate signature blocks and
    // back-fill their text IN PLACE before reordering, so the corrected names
    // (and never the scrambled printed guess) feed fullText / the embedding.
    // Best-effort: any failure inside the pass leaves the printed blocks intact.
    let handwrittenNames: HandwrittenName[] = [];
    if (handwritingPass) {
      try {
        handwrittenNames = await handwritingPass(imageBuffer, blocks);
      } catch {
        handwrittenNames = [];
      }
    }

    const ordered = reorderOcrBlocks(blocks);
    const fullText = buildFullTextFromBlocks(ordered);
    return {
      blocks,
      fullText,
      usedExternal: true,
      ocrVersion: OCR_VERSION_EXTERNAL,
      handwrittenNames,
    };
  } catch (e) {
    const msg =
      (e as Error).name === "AbortError"
        ? `OCR service timed out after ${env.ocrServiceTimeoutMs}ms`
        : `OCR service unreachable: ${(e as Error).message}`;
    return doFallback(msg);
  } finally {
    clearTimeout(timer);
  }
}
