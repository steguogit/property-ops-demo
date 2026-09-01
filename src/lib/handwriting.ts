import { env, hasVisionLLM } from "./env";
import {
  OcrBlock,
  HandwrittenName,
  HANDWRITING_ILLEGIBLE,
  findHandwrittenNameClusters,
} from "./ocrUtils";

// ---------------------------------------------------------------------------
// Multilingual handwritten-name recognition for HK tenancy forms.
//
// HK tenancy signatures come in three shapes: handwritten Traditional Chinese,
// handwritten English, or a mixed zh+en signature block. We deliberately do NOT
// deploy separate zh / en handwriting models. Instead:
//
//   1. PaddleOCR (the microservice) only DETECTS text regions. Printed body
//      text with confidence > 0.6 is kept verbatim from Paddle.
//   2. ocrUtils.findHandwrittenNameClusters() flags blocks in the signature
//      regions that are NOT high-confidence printed text, then CLUSTERS adjacent
//      candidates so a whole name (split by OCR into single glyphs) is treated
//      as one region.
//   3. THIS module crops each CLUSTER to a local image and sends it to ONE
//      multimodal model that transcribes zh / en / mixed names automatically —
//      no per-language model selection.
//   4. The model's reading back-fills block.text and produces a
//      HandwrittenName { nameText, lang } for the document top level.
//   5. If a crop is genuinely illegible, block.text becomes the placeholder
//      "[無法識別手寫姓名]" and the block (with its bbox) is KEPT, never dropped.
//
// Nothing here touches MongoDB. Persistence stays in extract.ts / ingest.ts.
// ---------------------------------------------------------------------------

/** Axis-aligned pixel rectangle derived from a 4-point polygon bbox. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function bboxToRect(
  bbox: [number, number][],
  pad: number,
  imgW: number,
  imgH: number
): Rect {
  const xs = bbox.map((p) => p[0]);
  const ys = bbox.map((p) => p[1]);
  let left = Math.floor(Math.min(...xs)) - pad;
  let top = Math.floor(Math.min(...ys)) - pad;
  let right = Math.ceil(Math.max(...xs)) + pad;
  let bottom = Math.ceil(Math.max(...ys)) + pad;
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(imgW, right);
  bottom = Math.min(imgH, bottom);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * Crop the candidate block's region out of the source image as a PNG buffer.
 *
 * A handwritten signature is frequently detected by OCR as a TINY, low-confidence
 * fragment (e.g. a single stroke read as "W"), even though the full name spans a
 * much larger area next to the field label. Cropping only that fragment gives the
 * vision model an unreadable sliver. So when `generous` is set (used for
 * low-confidence signature blocks) we EXPAND the crop well beyond the detected
 * polygon — a large multiple of the block size, plus an absolute floor — so the
 * whole handwritten name is captured. Returns null on any failure.
 */
async function cropBlock(
  imageBuffer: Buffer,
  bbox: [number, number][],
  generous = false
): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const base = sharp(imageBuffer, { failOn: "none" });
    const meta = await base.metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (!imgW || !imgH) return null;
    const xs = bbox.map((p) => p[0]);
    const ys = bbox.map((p) => p[1]);
    const blockW = Math.max(...xs) - Math.min(...xs);
    const blockH = Math.max(...ys) - Math.min(...ys);
    let pad: number;
    if (generous) {
      // Signature likely spills far past the detected fragment. Expand a lot:
      // ~1.5x the larger block dimension, with a floor of ~3% of the image's
      // shorter side, so a tiny "W" fragment still captures the full name.
      const bySize = Math.round(Math.max(blockW, blockH) * 1.5);
      const byImage = Math.round(Math.min(imgW, imgH) * 0.03);
      pad = Math.max(60, bySize, byImage);
    } else {
      pad = Math.max(6, Math.round(Math.min(blockW, blockH) * 0.25));
    }
    const rect = bboxToRect(bbox, pad, imgW, imgH);
    return await base.extract(rect).png().toBuffer();
  } catch {
    return null;
  }
}

/** Result of the multimodal read of one cropped name image. */
interface NameRead {
  nameText: string;
  lang: HandwrittenName["lang"];
}

/**
 * Ask the configured multimodal model to transcribe ONE cropped handwritten
 * name. The SAME model handles Chinese, English and mixed scripts — we never
 * branch on language. The model must return strict JSON so we can capture both
 * the name and its detected script; anything unparseable is treated as
 * illegible (the caller keeps the block with the placeholder text).
 */
async function readHandwrittenName(cropPng: Buffer): Promise<NameRead> {
  const b64 = cropPng.toString("base64");
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
      // NB: some gateway models (e.g. gpt-5.x) reject a non-default temperature,
      // returning HTTP 400 — which would make EVERY handwriting read fail. So we
      // do NOT send `temperature`; the default is fine for a single best read.
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You transcribe a SINGLE handwritten personal NAME from a Hong Kong tenancy document. " +
            "The name may be handwritten Traditional Chinese, handwritten English, or a mix of both in one signature. " +
            "Handle all scripts yourself — do not ask which language. " +
            "Read the strokes carefully and return your single best reading of the name only (no labels, no field text, no punctuation runs). " +
            'Respond with STRICT JSON: {"nameText": string, "lang": "zh" | "en" | "mixed" | "unknown", "legible": boolean}. ' +
            'If the handwriting is genuinely illegible, set legible=false and nameText="". Do NOT guess or invent a name.',
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe the handwritten name in this cropped image. Return the JSON described.",
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}`, detail: "high" },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `handwriting vision ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content?.trim() ?? "";
  return parseNameRead(content);
}

/** Parse the model's JSON reply, tolerating stray prose / code fences. */
function parseNameRead(content: string): NameRead {
  const illegible: NameRead = { nameText: HANDWRITING_ILLEGIBLE, lang: "unknown" };
  if (!content) return illegible;
  let obj: any = null;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
  }
  if (!obj || typeof obj !== "object") return illegible;
  const name = typeof obj.nameText === "string" ? obj.nameText.trim() : "";
  const legible = obj.legible !== false;
  if (!legible || !name) return illegible;
  // Reject obvious non-names: a single stray char / pure punctuation is OCR
  // noise from a mis-picked printed glyph, not a person's name.
  const stripped = name.replace(/[\s.,:：;；·、。()（）]/g, "");
  if (stripped.length < 2 && !/[\u3400-\u9fff]/.test(stripped)) return illegible;
  const lang: HandwrittenName["lang"] =
    obj.lang === "zh" || obj.lang === "en" || obj.lang === "mixed"
      ? obj.lang
      : inferLang(name);
  return { nameText: name, lang };
}

/** Fallback script detection from the transcribed characters. */
function inferLang(name: string): HandwrittenName["lang"] {
  const hasHan = /[\u3400-\u9fff]/.test(name);
  const hasLatin = /[A-Za-z]/.test(name);
  if (hasHan && hasLatin) return "mixed";
  if (hasHan) return "zh";
  if (hasLatin) return "en";
  return "unknown";
}

/**
 * Run the handwritten-name pass over one image's OCR blocks (mutates `blocks`
 * in place, back-filling candidate `text` and marking `handwritten`).
 *
 * - No-op (returns []) when no vision LLM is configured or no candidates match,
 *   so printed-only documents are unaffected and never incur an LLM call.
 * - Every candidate yields a HandwrittenName; illegible crops keep their bbox
 *   and get the placeholder text rather than being dropped.
 */
export async function recognizeHandwrittenNames(
  imageBuffer: Buffer,
  blocks: OcrBlock[]
): Promise<HandwrittenName[]> {
  if (!hasVisionLLM()) return [];
  const clusters = findHandwrittenNameClusters(blocks);
  if (!clusters.length) return [];

  // OCR is authoritative. The vision re-read only helps when OCR was NOT
  // confident about the name block. If OCR already read the cluster with decent
  // confidence AND it contains name characters, we KEEP the OCR text and never
  // let the (stochastic) vision read overwrite it.
  const OCR_TRUST = 0.8; // >= this OCR confidence => trust OCR, skip override
  const hasNameChars = (s: string) => /[\u4e00-\u9fffA-Za-z]/.test(s || "");

  const names: HandwrittenName[] = [];
  // Sequential per cluster: a tenancy form has only a handful of name/signature
  // regions, and the vision endpoint may be rate-limited.
  for (const cluster of clusters) {
    const firstIdx = cluster.memberIndices[0];
    const ocrText = (blocks[firstIdx]?.text ?? "").trim();
    const ocrConfident =
      cluster.minConfidence >= OCR_TRUST && hasNameChars(ocrText);

    if (ocrConfident) {
      // Trust OCR: mark handwritten, keep OCR text, record OCR reading as the
      // name. NO vision call, so nothing can clobber a good reading.
      cluster.memberIndices.forEach((idx) => {
        if (blocks[idx]) blocks[idx].handwritten = true;
      });
      names.push({
        nameText: ocrText,
        lang: inferLang(ocrText),
        bbox: cluster.bbox,
        sourceConfidence: cluster.minConfidence,
      });
      continue;
    }

    // OCR was NOT confident here → ask the vision model to re-read this crop.
    // Use a GENEROUS crop: a low-confidence signature is usually a small fragment
    // of a much larger handwritten name, so we expand the region to capture the
    // whole signature (a tight crop gives the model an unreadable sliver).
    let read: NameRead = { nameText: HANDWRITING_ILLEGIBLE, lang: "unknown" };
    const crop = await cropBlock(imageBuffer, cluster.bbox, /* generous */ true);
    if (crop) {
      try {
        read = await readHandwrittenName(crop);
      } catch {
        read = { nameText: HANDWRITING_ILLEGIBLE, lang: "unknown" };
      }
    }
    // Only override with the vision read if it is legible; otherwise KEEP
    // whatever OCR had (even if weak) rather than blanking useful text.
    const visionLegible =
      !!read.nameText &&
      read.nameText !== HANDWRITING_ILLEGIBLE &&
      hasNameChars(read.nameText);
    cluster.memberIndices.forEach((idx, order) => {
      const block = blocks[idx];
      if (!block) return;
      block.handwritten = true;
      if (visionLegible) block.text = order === 0 ? read.nameText : "";
    });
    names.push({
      nameText: visionLegible
        ? read.nameText
        : hasNameChars(ocrText)
          ? ocrText
          : HANDWRITING_ILLEGIBLE,
      lang: visionLegible ? read.lang : inferLang(ocrText),
      bbox: cluster.bbox,
      sourceConfidence: cluster.minConfidence,
    });
  }
  return names;
}
