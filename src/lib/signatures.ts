import { Readable } from "stream";
import { randomUUID, createHash } from "crypto";
import {
  getSignaturesCollection,
  getFileBucket,
  deleteOriginalFile,
  getDb,
  SignatureDoc,
} from "./mongo";
import { env } from "./env";
import { voyageEmbedMultimodalImageOne } from "./voyage";

/** Normalized crop rectangle (0..1 of image width/height). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crop an image to a normalized rectangle so we embed ONLY the signature region
 * (not the whole scanned page). Embedding the whole page makes two documents
 * with identical printed layout look >85% similar even when the handwritten
 * signatures differ — cropping to the signature fixes that.
 *
 * NOTE: @napi-rs/canvas.loadImage ALREADY applies EXIF orientation (its
 * width/height are the display dimensions), which matches what the browser
 * shows. So the normalized crop rect (measured against the on-screen image) maps
 * directly onto loadImage's pixels — no manual rotation needed. Returns PNG
 * bytes of the crop; on any failure it falls back to the original bytes.
 */
export async function cropImage(
  buffer: Buffer,
  mime: string,
  rect?: CropRect | null
): Promise<{ buffer: Buffer; mime: string }> {
  if (!rect) return { buffer, mime };
  // Clamp to valid normalized bounds.
  const x = Math.min(Math.max(rect.x, 0), 1);
  const y = Math.min(Math.max(rect.y, 0), 1);
  const w = Math.min(Math.max(rect.w, 0), 1 - x);
  const h = Math.min(Math.max(rect.h, 0), 1 - y);
  if (w <= 0.001 || h <= 0.001) return { buffer, mime };

  try {
    const canvas = await import("@napi-rs/canvas");
    const img = await canvas.loadImage(buffer); // EXIF already applied
    const iw = img.width;
    const ih = img.height;
    const cx = Math.round(x * iw);
    const cy = Math.round(y * ih);
    const cw = Math.max(1, Math.round(w * iw));
    const ch = Math.max(1, Math.round(h * ih));
    const out = canvas.createCanvas(cw, ch);
    const ctx = out.getContext("2d");
    // White background (signatures are usually on white; avoids transparency).
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
    const png = out.toBuffer("image/png");
    return { buffer: png, mime: "image/png" };
  } catch {
    // Canvas unavailable / decode failed — fall back to the whole image.
    return { buffer, mime };
  }
}

// ---------------------------------------------------------------------------
// Signature comparison.
//
// Enrolment: store the signature image in GridFS + compute a voyage-multimodal-
// 3.5 IMAGE embedding, indexed for vector search.
//
// Comparison: embed the query signature image, run $vectorSearch against the
// enrolled specimens, and band each hit by cosine similarity into
// match / review / no-match. Accuracy is driven by (1) the image embedding
// model and (2) the calibrated thresholds — not by any text/OCR step.
// ---------------------------------------------------------------------------

export type MatchBand = "match" | "review" | "no_match";

export interface SignatureMatch {
  signatureId: string;
  signerName: string;
  label?: string;
  originalFileId?: string;
  mimeType?: string;
  /** The signature region that was embedded (for overlay in the UI). */
  cropRect?: CropRect | null;
  /** Cosine similarity (0..1). */
  similarity: number;
  band: MatchBand;
}

function bandFor(similarity: number): MatchBand {
  if (similarity >= env.signatureMatchThreshold) return "match";
  if (similarity >= env.signatureReviewThreshold) return "review";
  return "no_match";
}

/** A single step in the auto-detect pipeline (for the "view process" dialog). */
export interface DetectStep {
  /** English fallback text. */
  step: string;
  status: "ok" | "warn" | "error";
  ms?: number;
  /** English fallback note. */
  note?: string;
  /** i18n key for the step title (frontend translates). */
  stepKey?: string;
  /** i18n key for the note (frontend translates). */
  noteKey?: string;
  /** Interpolation vars for the note key. */
  vars?: Record<string, string | number>;
}

export interface DetectResult {
  /**
   * Primary (best) detected signature region, or null if none.
   * Kept for backward compatibility with callers/UI that expect a single box —
   * it always mirrors cropRects[0].
   */
  cropRect: CropRect | null;
  /**
   * ALL detected signature regions (stabilised + ordered top→bottom,
   * left→right). Empty when none found. A document may contain more than one
   * handwritten signature (e.g. tenant + landlord), so callers can offer the
   * user a choice of which region to enrol/compare.
   */
  cropRects: CropRect[];
  steps: DetectStep[];
  /** Raw model output (trimmed) for transparency. */
  rawResponse?: string;
}

// ---------------------------------------------------------------------------
// Detection cache.
//
// The vision model is non-deterministic for spatial localization (see the
// `seed`/quantization notes below), so the SAME uploaded image can yield a
// different box — and therefore a different comparison SCORE — on each call.
// To make detection reproducible we key a tiny cache by the SHA-256 of the
// image bytes: the first detection for an image is stabilised and stored; every
// later detection of the identical image returns that exact box. This removes
// the run-to-run variance the user observed.
// ---------------------------------------------------------------------------
const DETECT_CACHE_COLLECTION = "signature_detect_cache";

function imageHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function getCachedDetection(
  hash: string
): Promise<CropRect[] | undefined> {
  try {
    const db = await getDb();
    const doc = await db
      .collection(DETECT_CACHE_COLLECTION)
      .findOne({ _id: hash } as any);
    if (!doc) return undefined; // no entry => cache miss
    const d = doc as any;
    // New format: cropRects[] (may be []). Fall back to legacy single cropRect.
    if (Array.isArray(d.cropRects)) return d.cropRects as CropRect[];
    if (d.cropRect) return [d.cropRect as CropRect];
    return []; // cached "no signature"
  } catch {
    return undefined; // cache is best-effort; never block detection
  }
}

async function putCachedDetection(
  hash: string,
  cropRects: CropRect[]
): Promise<void> {
  try {
    const db = await getDb();
    await db.collection(DETECT_CACHE_COLLECTION).updateOne(
      { _id: hash } as any,
      {
        // Store the array; also mirror the primary box in `cropRect` so any
        // legacy reader still works.
        $set: {
          cropRects,
          cropRect: cropRects[0] ?? null,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch {
    /* best-effort */
  }
}

/** Pad + quantize a single raw box for run-to-run stability (see notes below). */
function stabilizeBox(
  rawX: number,
  rawY: number,
  rawW: number,
  rawH: number
): CropRect {
  const PAD = 0.03; // fractional padding added on every side
  const GRID = 0.05; // quantization grid
  const snap = (n: number) => Math.round(n / GRID) * GRID;
  const px = Math.max(0, rawX - PAD);
  const py = Math.max(0, rawY - PAD);
  const pw = Math.min(1 - px, rawW + 2 * PAD);
  const ph = Math.min(1 - py, rawH + 2 * PAD);
  const x = Math.min(Math.max(snap(px), 0), 1);
  const y = Math.min(Math.max(snap(py), 0), 1);
  const w = Math.min(Math.max(snap(pw), GRID), 1 - x);
  const h = Math.min(Math.max(snap(ph), GRID), 1 - y);
  return { x, y, w, h };
}

/**
 * Auto-detect the signature region in an image via the vision LLM. Returns a
 * normalized crop rect (0..1) plus a step-by-step trace of what happened, so the
 * UI can show the process. Best-effort — the UI lets the user adjust the box.
 *
 * Determinism: results are cached by image hash so repeated detection of the
 * SAME image is 100% consistent. The raw model box is also padded + quantized
 * (see below) so even a first-time detection is stable to small model jitter.
 */
export async function detectSignatureRegion(
  buffer: Buffer,
  mime: string
): Promise<DetectResult> {
  const steps: DetectStep[] = [];
  const timer = (name: string, stepKey: string) => {
    const t0 = Date.now();
    return (
      status: DetectStep["status"],
      note?: string,
      noteKey?: string,
      vars?: Record<string, string | number>
    ) =>
      steps.push({
        step: name,
        stepKey,
        status,
        ms: Date.now() - t0,
        note,
        noteKey,
        vars,
      });
  };

  if (!env.llmApiKey) {
    steps.push({
      step: "check vision model",
      stepKey: "sig.proc.checkModel",
      status: "error",
      note: "No vision LLM configured (LLM_API_KEY unset).",
      noteKey: "sig.proc.noModel",
    });
    return { cropRect: null, cropRects: [], steps };
  }

  // Step 0: cache lookup by image hash — makes repeat detection deterministic.
  const hash = imageHash(buffer);
  const endCache = timer("Check detection cache", "sig.proc.cache");
  const cached = await getCachedDetection(hash);
  if (cached !== undefined) {
    endCache(
      "ok",
      `returned ${cached.length} previously stabilised box(es) for this exact image`,
      "sig.proc.cacheHit",
      { count: cached.length }
    );
    return { cropRect: cached[0] ?? null, cropRects: cached, steps };
  }
  endCache("ok", "no cached box; running the vision model", "sig.proc.cacheMiss");

  // Step 1: prepare image.
  const endPrep = timer("Prepare image", "sig.proc.prepare");
  const b64 = buffer.toString("base64");
  const kb = Math.round(buffer.length / 1024);
  // Grab the pixel dimensions so we can normalise the model's box if it returns
  // ABSOLUTE PIXEL coordinates instead of the requested 0..1 fractions (it does
  // this inconsistently, especially on smaller images — see the parse step).
  let imgW = 0;
  let imgH = 0;
  try {
    const canvas = await import("@napi-rs/canvas");
    const img = await canvas.loadImage(buffer);
    imgW = img.width;
    imgH = img.height;
  } catch {
    /* dimensions best-effort; fraction-only handling still works */
  }
  endPrep(
    "ok",
    `${mime}, ${kb} KB → base64 data URI (detail: high)`,
    "sig.proc.prepareNote",
    { mime, kb }
  );

  // Step 2: call the vision model to locate the signature.
  const endCall = timer(
    `Vision model localises signature (${env.llmModel})`,
    "sig.proc.locate"
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.llmAuthHeader === "api-key") headers["api-key"] = env.llmApiKey;
  else headers["Authorization"] = `Bearer ${env.llmApiKey}`;

  let raw = "";
  try {
    const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: env.llmModel,
        // Determinism: without this, the model returns a slightly different
        // bounding box on every call, which shifts the crop and makes the
        // comparison SCORE wobble run-to-run. We pin a fixed `seed` so the same
        // image yields the same box (and thus a stable score).
        // NB: this model (gpt-5.x) REJECTS a non-default `temperature` with HTTP
        // 400 (verified against the gateway), so we must NOT send temperature —
        // `seed` is the only determinism lever available here.
        seed: 42,
        messages: [
          {
            role: "system",
            content:
              "You locate EVERY handwritten signature in a scanned document image. " +
              "A document may contain more than one signature (e.g. tenant AND landlord, or multiple signatories). " +
              "Return ONLY a compact JSON object of the form " +
              '{"boxes":[{"x":<left>,"y":<top>,"w":<width>,"h":<height>}, ...]} ' +
              "where each box is the bounding box of ONE signature as fractions of the image dimensions (0..1). " +
              "Each box should tightly enclose that signature's handwritten strokes, excluding printed labels like 'Signature:'. " +
              "Do NOT include printed/typeset text, stamps of printed characters, or vertical printed column headers — only genuine handwritten signatures. " +
              'If there are no handwritten signatures, return {"boxes":[]}. Output JSON only, no prose.',
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Find all handwritten signature regions." },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${b64}`, detail: "high" },
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      endCall("error", `vision API ${res.status}`, "sig.proc.apiErr", {
        status: res.status,
        model: env.llmModel,
      });
      return { cropRect: null, cropRects: [], steps };
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    raw = json.choices?.[0]?.message?.content ?? "";
    endCall("ok", "model returned a response", "sig.proc.locateNote", {
      model: env.llmModel,
    });
  } catch (e) {
    endCall("error", (e as Error).message, "sig.proc.callFailed", {
      msg: (e as Error).message,
    });
    return { cropRect: null, cropRects: [], steps };
  }

  // Step 3: parse the bounding box(es).
  const endParse = timer("Parse bounding boxes", "sig.proc.parse");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    endParse("warn", "no JSON found in model output", "sig.proc.noJson");
    return { cropRect: null, cropRects: [], steps, rawResponse: raw.slice(0, 400) };
  }
  try {
    const parsed = JSON.parse(m[0]);

    // Accept several shapes for robustness:
    //   { "boxes": [ {x,y,w,h}, ... ] }   (new, preferred)
    //   { "none": true }                  (legacy "no signature")
    //   { x,y,w,h }                       (legacy single box)
    let rawBoxes: any[] = [];
    if (Array.isArray(parsed.boxes)) rawBoxes = parsed.boxes;
    else if (parsed.none) rawBoxes = [];
    else if (typeof parsed.x === "number") rawBoxes = [parsed];

    // The model is asked for FRACTIONS (0..1) but inconsistently returns
    // ABSOLUTE PIXEL coordinates instead (more often on smaller images). If we
    // treated pixels as fractions they'd clamp to the image edge and collapse
    // together — which is exactly why some documents (e.g. a low-res photo)
    // yielded only ONE region. Detect the unit PER RESPONSE: if any coordinate
    // exceeds ~1.5, the whole response is pixels, so divide by the image
    // dimensions to recover fractions.
    const looksPixel = rawBoxes.some((b) =>
      [b?.x, b?.y, b?.w, b?.h].some((n) => Number(n) > 1.5)
    );
    const toFraction = (b: any) => {
      const x = Number(b?.x);
      const y = Number(b?.y);
      const w = Number(b?.w);
      const h = Number(b?.h);
      if (looksPixel && imgW > 0 && imgH > 0) {
        return { x: x / imgW, y: y / imgH, w: w / imgW, h: h / imgH };
      }
      return { x, y, w, h };
    };

    // Keep only boxes with valid, non-degenerate numbers, then stabilise each.
    const stabilized: CropRect[] = [];
    for (const b of rawBoxes) {
      const { x: rawX, y: rawY, w: rawW, h: rawH } = toFraction(b);
      if ([rawX, rawY, rawW, rawH].some((n) => Number.isNaN(n))) continue;
      if (rawW <= 0.005 || rawH <= 0.005) continue; // ignore slivers
      // Stabilise each box. This model rejects temperature:0 (HTTP 400) and
      // treats `seed` as best-effort, so the RAW box drifts by up to ~8% between
      // identical calls — which shifts the crop and makes the comparison SCORE
      // inconsistent. stabilizeBox() PADS (so edge strokes stay inside the crop)
      // and SNAPS to a coarse 0.05 grid (so wobble collapses onto the same box).
      stabilized.push(stabilizeBox(rawX, rawY, rawW, rawH));
    }

    // De-duplicate boxes that quantized to (nearly) the same rectangle — the
    // model sometimes returns the same signature twice, or two boxes that snap
    // together. Then order top→bottom, left→right for stable, human presentation.
    const boxes = dedupeBoxes(stabilized).sort((a, b) =>
      Math.abs(a.y - b.y) > 0.05 ? a.y - b.y : a.x - b.x
    );

    if (boxes.length === 0) {
      endParse(
        "warn",
        "model reported no handwritten signature",
        "sig.proc.noneFound"
      );
      await putCachedDetection(hash, []); // cache the "none" verdict
      return { cropRect: null, cropRects: [], steps, rawResponse: m[0] };
    }

    endParse(
      "ok",
      `found ${boxes.length} signature region(s)`,
      "sig.proc.boxesNote",
      { count: boxes.length }
    );
    steps.push({
      step: "Crop → embed (on enrol/compare)",
      stepKey: "sig.proc.embed",
      status: "ok",
      note:
        "Each selected region is cropped and embedded with " +
        `${env.multimodalEmbedModel} into a 1024-d vector.`,
      noteKey: "sig.proc.embedNote",
      vars: { model: env.multimodalEmbedModel },
    });
    // Persist the stabilised boxes so every later detection of this exact image
    // returns the identical regions (and thus identical comparison scores).
    await putCachedDetection(hash, boxes);
    return { cropRect: boxes[0], cropRects: boxes, steps, rawResponse: m[0] };
  } catch {
    endParse("warn", "failed to parse model JSON", "sig.proc.parseFailed");
    return { cropRect: null, cropRects: [], steps, rawResponse: raw.slice(0, 400) };
  }
}

/** Intersection-over-Union of two normalized boxes (0 = disjoint, 1 = identical). */
function iou(a: CropRect, b: CropRect): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Merge boxes that refer to the SAME signature, keeping genuinely-separate ones.
 * The model often returns two overlapping boxes for one signature (a tall + a
 * short fragment). Position/size closeness misses those (they can be shifted),
 * so we merge by OVERLAP: if two boxes have IoU >= 0.4 we treat them as the same
 * signature and keep their UNION (so the whole signature is captured). Boxes
 * that barely overlap are kept separate (e.g. tenant vs landlord).
 */
function dedupeBoxes(boxes: CropRect[]): CropRect[] {
  const out: CropRect[] = [];
  for (const b of boxes) {
    const hitIndex = out.findIndex((o) => iou(o, b) >= 0.4);
    if (hitIndex === -1) {
      out.push(b);
    } else {
      // Merge into the union of the two overlapping boxes.
      const o = out[hitIndex];
      const x = Math.min(o.x, b.x);
      const y = Math.min(o.y, b.y);
      const w = Math.max(o.x + o.w, b.x + b.w) - x;
      const h = Math.max(o.y + o.h, b.y + b.h) - y;
      out[hitIndex] = { x, y, w, h };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document-level signature classification (used during ingestion).
// ---------------------------------------------------------------------------

export interface DocSignatureResult {
  status: "signed" | "unsigned" | "not_required" | "unknown";
  box: CropRect | null;
  note: string;
}

/** Run the vision model over a page image and classify signature status. */
async function visionClassifySignature(
  b64: string,
  mime: string
): Promise<DocSignatureResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.llmAuthHeader === "api-key") headers["api-key"] = env.llmApiKey;
  else headers["Authorization"] = `Bearer ${env.llmApiKey}`;

  const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.llmModel,
      messages: [
        {
          role: "system",
          content:
            "You audit whether a scanned document has been signed. Look for a signature line / field / area (labels like 'Signature', '簽名', '署名', 'Signed by', 'Authorised by', a chop/stamp box, or an underline where a signature belongs). " +
            "Decide one of: " +
            '"signed" (a signature field/area EXISTS and a handwritten signature or chop is present in it), ' +
            '"unsigned" (a signature field/line/area EXISTS but it is EMPTY / not filled), ' +
            '"not_required" (there is NO signature field anywhere and the document is not a type that needs signing, e.g. a manual, report, or floor plan). ' +
            "IMPORTANT: if a signature area exists but is blank, you MUST return \"unsigned\" (never \"not_required\"). " +
            "Respond ONLY with compact JSON: " +
            '{"status":"signed|unsigned|not_required","box":{"x":..,"y":..,"w":..,"h":..}|null,"reason":"short reason"}. ' +
            "The box (fractions of the image, 0..1) locates the signature (for signed) or the empty signature field (for unsigned); use null only for not_required. Output JSON only.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Has this document been signed?" },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${b64}`, detail: "high" },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    return { status: "unknown", box: null, note: `vision API ${res.status}` };
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const raw = json.choices?.[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { status: "unknown", box: null, note: "no JSON from model" };
  const parsed = JSON.parse(m[0]);
  const status: DocSignatureResult["status"] = [
    "signed",
    "unsigned",
    "not_required",
  ].includes(parsed.status)
    ? parsed.status
    : "unknown";
  let box: CropRect | null = null;
  if (
    parsed.box &&
    [parsed.box.x, parsed.box.y, parsed.box.w, parsed.box.h].every(
      (n: any) => typeof n === "number" && !Number.isNaN(n)
    )
  ) {
    box = { x: parsed.box.x, y: parsed.box.y, w: parsed.box.w, h: parsed.box.h };
  }
  return {
    status,
    box,
    note: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/**
 * Rasterise the FIRST page of a PDF to a PNG image so it can be inspected
 * visually (signatures are usually near the end, but the first page carries the
 * signature block in most single-page agreements; for multi-page we render the
 * LAST page which typically holds the signature block). Returns null on failure.
 */
async function rasterizePdfPage(
  buffer: Buffer,
  which: "first" | "last" = "last"
): Promise<string | null> {
  try {
    const canvas = await import("@napi-rs/canvas");
    const g = globalThis as Record<string, unknown>;
    if (!g.DOMMatrix && (canvas as any).DOMMatrix)
      g.DOMMatrix = (canvas as any).DOMMatrix;
    if (!g.Path2D && (canvas as any).Path2D)
      g.Path2D = (canvas as any).Path2D;
    if (!g.ImageData && (canvas as any).ImageData)
      g.ImageData = (canvas as any).ImageData;

    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Resolve pdfjs' bundled standard fonts so text glyphs actually render
    // (otherwise the page rasterises blank and looks like "no content").
    let standardFontDataUrl: string | undefined;
    try {
      const path = await import("path");
      const fs = await import("fs");
      const candidates = [
        path.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts") + "/",
        path.join(
          process.cwd(),
          ".next/server/node_modules/pdfjs-dist/standard_fonts"
        ) + "/",
      ];
      const dir = candidates.find((p) => fs.existsSync(p));
      if (dir) standardFontDataUrl = "file://" + dir;
    } catch {
      /* best effort */
    }
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      isEvalSupported: false,
      standardFontDataUrl,
    });
    const pdf = await loadingTask.promise;
    const pageNum = which === "last" ? pdf.numPages : 1;
    const page = await pdf.getPage(pageNum);
    // Scale to a reasonable resolution for the vision model.
    const viewport = page.getViewport({ scale: 2 });
    const c = canvas.createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx as any, viewport }).promise;
    return c.toBuffer("image/png").toString("base64");
  } catch {
    return null;
  }
}

/**
 * Classify a document's signature status.
 *   - image  → vision model inspects the page.
 *   - pdf    → rasterise a page and run the SAME vision model, so an empty
 *              signature area is correctly marked "unsigned" (not "not_required").
 *   - other  → light text heuristic on the extracted text.
 */
export async function detectDocumentSignature(
  buffer: Buffer,
  mime: string,
  fileType: string,
  extractedText: string
): Promise<DocSignatureResult> {
  // Image path.
  if (fileType === "image" && env.llmApiKey && mime.startsWith("image/")) {
    try {
      return await visionClassifySignature(buffer.toString("base64"), mime);
    } catch (e) {
      return { status: "unknown", box: null, note: (e as Error).message };
    }
  }

  // Whether the extracted text mentions a signature field/label.
  const txt = (extractedText || "").toLowerCase();
  const hasSigField =
    /signature|signed by|authoris(e|ed) by|簽\s*名|署\s*名|簽署/.test(txt);

  // PDF path: rasterise a page and inspect it visually.
  if (fileType === "pdf" && env.llmApiKey) {
    try {
      const pageB64 = await rasterizePdfPage(buffer, "last");
      if (pageB64) {
        const v = await visionClassifySignature(pageB64, "image/png");
        // The rendered page can be text-sparse (fonts not embedded), so the
        // vision model may miss a signature field it can't "see". If the
        // extracted TEXT clearly has a signature field but vision said
        // not_required, trust the text signal and mark it unsigned for review.
        if (v.status === "not_required" && hasSigField) {
          return {
            status: "unsigned",
            box: v.box,
            note: "A signature field is present in the document text but no signature was detected — please review.",
          };
        }
        if (v.status !== "unknown") return v;
      }
      // Rasterisation failed — fall through to the text heuristic below.
    } catch {
      /* fall through to heuristic */
    }
  }

  // Text heuristic for non-visual documents (docx/xlsx/text) or PDF fallback.
  if (!hasSigField) {
    return {
      status: "not_required",
      box: null,
      note: "No signature field found in the extracted text.",
    };
  }
  // A signature field exists in the text; we can't confirm visually here.
  return {
    status: "unsigned",
    box: null,
    note: "Signature field found in text, but this file type couldn't be visually verified — please review.",
  };
}

/** Enrol a reference signature: store bytes + image embedding. */
export async function enrollSignature(input: {
  buffer: Buffer;
  mime: string;
  fileName: string;
  signerName: string;
  label?: string;
  cropRect?: CropRect | null;
}): Promise<SignatureDoc> {
  const col = await getSignaturesCollection();
  const now = new Date().toISOString();
  const signatureId = `SIG-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Store the ORIGINAL (uncropped) image in GridFS for preview.
  let originalFileId: string | undefined;
  try {
    const bucket = await getFileBucket();
    originalFileId = await new Promise<string>((resolve, reject) => {
      const stream = bucket.openUploadStream(input.fileName, {
        contentType: input.mime,
        metadata: { signatureId, kind: "signature", uploadedAt: now },
      });
      Readable.from(input.buffer)
        .pipe(stream)
        .on("error", reject)
        .on("finish", () => resolve(stream.id.toString()));
    });
  } catch {
    /* preview is best-effort */
  }

  // Crop to the signature region (if provided) BEFORE embedding, so the vector
  // represents the signature, not the whole page.
  const cropped = await cropImage(input.buffer, input.mime, input.cropRect);

  // Image embedding — the match signal.
  const embedding = await voyageEmbedMultimodalImageOne(
    cropped.buffer,
    cropped.mime,
    "document"
  );

  const doc: SignatureDoc = {
    _id: signatureId,
    signatureId,
    signerName: input.signerName.trim(),
    label: input.label?.trim() || undefined,
    embedding,
    originalFileId,
    mimeType: input.mime,
    fileSizeBytes: input.buffer.length,
    cropRect: input.cropRect ?? undefined,
    createdAt: now,
  };
  await col.insertOne(doc as any);
  return doc;
}

/**
 * Enrol MULTIPLE signature regions from a single document in one call — each
 * region becomes its own specimen (its own embedding + signer name), so a form
 * signed by e.g. a tenant AND a landlord yields two independently-matchable
 * specimens. Regions with a blank signer name are skipped.
 */
export async function enrollSignatureRegions(input: {
  buffer: Buffer;
  mime: string;
  fileName: string;
  regions: Array<{ signerName: string; label?: string; cropRect: CropRect }>;
}): Promise<SignatureDoc[]> {
  const out: SignatureDoc[] = [];
  for (const r of input.regions) {
    if (!r.signerName?.trim()) continue; // skip unnamed regions
    const doc = await enrollSignature({
      buffer: input.buffer,
      mime: input.mime,
      fileName: input.fileName,
      signerName: r.signerName,
      label: r.label,
      cropRect: r.cropRect,
    });
    out.push(doc);
  }
  return out;
}

export async function listSignatures(): Promise<SignatureDoc[]> {
  const col = await getSignaturesCollection();
  return col
    .find({}, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
}

export async function deleteSignature(signatureId: string): Promise<void> {
  const col = await getSignaturesCollection();
  const doc = await col.findOne({ signatureId });
  await deleteOriginalFile(doc?.originalFileId);
  await col.deleteOne({ signatureId });
}

/**
 * Compare a query signature image against all enrolled specimens. Returns the
 * top matches ranked by cosine similarity, each banded by confidence.
 */
export async function compareSignature(
  buffer: Buffer,
  mime: string,
  limit = 5,
  cropRect?: CropRect | null
): Promise<{ matches: SignatureMatch[]; queryEmbedded: boolean }> {
  const matches = await matchOneRegion(buffer, mime, cropRect ?? null, limit);
  return { matches, queryEmbedded: true };
}

/**
 * Embed ONE region of the query image and vector-search the enrolled specimens.
 * Shared by both the single-region compare and the per-region multi-compare.
 */
async function matchOneRegion(
  buffer: Buffer,
  mime: string,
  cropRect: CropRect | null,
  limit: number
): Promise<SignatureMatch[]> {
  const col = await getSignaturesCollection();
  // Crop the query to its signature region too, so we compare signature-to-
  // signature (matching how enrolled specimens were embedded).
  // IMPORTANT: use the SAME input_type ("document") as enrolment. The
  // multimodal model prepends a different instruction per input_type, so a
  // "query"-typed vector of the identical signature only scores ~0.98 against a
  // "document"-typed one — signature matching is symmetric image-to-image, so
  // both sides must use the same type to get ~1.0 on a true match.
  const cropped = await cropImage(buffer, mime, cropRect);
  const queryVector = await voyageEmbedMultimodalImageOne(
    cropped.buffer,
    cropped.mime,
    "document"
  );

  const pipeline = [
    {
      $vectorSearch: {
        index: env.signatureVectorIndex,
        path: "embedding",
        queryVector,
        numCandidates: 200,
        limit,
      },
    },
    {
      $project: {
        _id: 0,
        signatureId: 1,
        signerName: 1,
        label: 1,
        originalFileId: 1,
        mimeType: 1,
        cropRect: 1,
        similarity: { $meta: "vectorSearchScore" },
      },
    },
  ];

  const docs = await col.aggregate(pipeline).toArray();
  return docs.map((d: any) => ({
    signatureId: d.signatureId,
    signerName: d.signerName,
    label: d.label,
    originalFileId: d.originalFileId,
    mimeType: d.mimeType,
    cropRect: d.cropRect ?? null,
    similarity: d.similarity ?? 0,
    band: bandFor(d.similarity ?? 0),
  }));
}

/** A comparison result for ONE detected region of the query document. */
export interface RegionCompareResult {
  /** 1-based index of the region within the query document. */
  regionIndex: number;
  /** The region that was embedded (for UI overlay). */
  cropRect: CropRect;
  /** Ranked matches for THIS region (best first). */
  matches: SignatureMatch[];
  /** Convenience: the single best match (matches[0]) or null. */
  best: SignatureMatch | null;
}

/**
 * Compare EVERY detected signature region of a query document against the
 * enrolled specimens, returning the best match PER REGION. This is the natural
 * model for a real scenario: the user doesn't know which enrolled specimen a
 * document's signatures should map to — vector search finds the best match for
 * each region automatically (e.g. region 1 → Tenant 0.94, region 2 → Landlord
 * 0.91). If no regions are supplied we fall back to auto-detecting them.
 */
export async function compareSignatureRegions(
  buffer: Buffer,
  mime: string,
  regions?: CropRect[] | null,
  limit = 5
): Promise<{ regions: RegionCompareResult[]; detected: boolean }> {
  let boxes = regions ?? null;
  let detected = false;
  if (!boxes || boxes.length === 0) {
    const det = await detectSignatureRegion(buffer, mime);
    boxes = det.cropRects;
    detected = true;
  }
  // No region at all: compare the whole image as a single implicit region so
  // the caller still gets a result.
  if (!boxes || boxes.length === 0) {
    const matches = await matchOneRegion(buffer, mime, null, limit);
    return {
      regions: [
        {
          regionIndex: 1,
          cropRect: { x: 0, y: 0, w: 1, h: 1 },
          matches,
          best: matches[0] ?? null,
        },
      ],
      detected,
    };
  }

  const results: RegionCompareResult[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const matches = await matchOneRegion(buffer, mime, boxes[i], limit);
    results.push({
      regionIndex: i + 1,
      cropRect: boxes[i],
      matches,
      best: matches[0] ?? null,
    });
  }
  return { regions: results, detected };
}
