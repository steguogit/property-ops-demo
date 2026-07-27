import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  getSignaturesCollection,
  getFileBucket,
  deleteOriginalFile,
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
  cropRect: CropRect | null;
  steps: DetectStep[];
  /** Raw model output (trimmed) for transparency. */
  rawResponse?: string;
}

/**
 * Auto-detect the signature region in an image via the vision LLM. Returns a
 * normalized crop rect (0..1) plus a step-by-step trace of what happened, so the
 * UI can show the process. Best-effort — the UI lets the user adjust the box.
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
    return { cropRect: null, steps };
  }

  // Step 1: prepare image.
  const endPrep = timer("Prepare image", "sig.proc.prepare");
  const b64 = buffer.toString("base64");
  const kb = Math.round(buffer.length / 1024);
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
        messages: [
          {
            role: "system",
            content:
              "You locate the handwritten signature in a scanned document image. " +
              "Return ONLY a compact JSON object with the bounding box of the signature as fractions of the image dimensions (0..1): " +
              '{"x":<left>,"y":<top>,"w":<width>,"h":<height>}. ' +
              "The box should tightly enclose the handwritten signature strokes, excluding printed labels like 'Signature:'. " +
              'If there is no handwritten signature, return {"none":true}. Output JSON only, no prose.',
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Find the handwritten signature region." },
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
      return { cropRect: null, steps };
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
    return { cropRect: null, steps };
  }

  // Step 3: parse the bounding box.
  const endParse = timer("Parse bounding box", "sig.proc.parse");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    endParse("warn", "no JSON found in model output", "sig.proc.noJson");
    return { cropRect: null, steps, rawResponse: raw.slice(0, 400) };
  }
  try {
    const parsed = JSON.parse(m[0]);
    if (parsed.none) {
      endParse(
        "warn",
        "model reported no handwritten signature",
        "sig.proc.noneFound"
      );
      return { cropRect: null, steps, rawResponse: m[0] };
    }
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    const w = Number(parsed.w);
    const h = Number(parsed.h);
    if ([x, y, w, h].some((n) => Number.isNaN(n))) {
      endParse("warn", "bounding box was not valid numbers", "sig.proc.badBox");
      return { cropRect: null, steps, rawResponse: m[0] };
    }
    endParse(
      "ok",
      `box x:${x.toFixed(2)} y:${y.toFixed(2)} w:${w.toFixed(
        2
      )} h:${h.toFixed(2)} (fractions of the page)`,
      "sig.proc.boxNote",
      {
        x: x.toFixed(2),
        y: y.toFixed(2),
        w: w.toFixed(2),
        h: h.toFixed(2),
      }
    );
    steps.push({
      step: "Crop → embed (on enrol/compare)",
      stepKey: "sig.proc.embed",
      status: "ok",
      note:
        "Only this region is cropped and embedded with " +
        `${env.multimodalEmbedModel} into a 1024-d vector.`,
      noteKey: "sig.proc.embedNote",
      vars: { model: env.multimodalEmbedModel },
    });
    return { cropRect: { x, y, w, h }, steps, rawResponse: m[0] };
  } catch {
    endParse("warn", "failed to parse model JSON", "sig.proc.parseFailed");
    return { cropRect: null, steps, rawResponse: raw.slice(0, 400) };
  }
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
  const matches: SignatureMatch[] = docs.map((d: any) => ({
    signatureId: d.signatureId,
    signerName: d.signerName,
    label: d.label,
    originalFileId: d.originalFileId,
    mimeType: d.mimeType,
    cropRect: d.cropRect ?? null,
    similarity: d.similarity ?? 0,
    band: bandFor(d.similarity ?? 0),
  }));

  return { matches, queryEmbedded: true };
}
