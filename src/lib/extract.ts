import { env, hasVisionLLM } from "./env";

// ---------------------------------------------------------------------------
// Text extraction for uploaded files.
//
// Strategy per type (see README "supported file-type behavior"):
//   pdf   -> pdf-parse (text layer). If the text layer is empty/scanned, fall
//            back to OCR / LLM-vision (caveated: image-only PDFs need page
//            rasterisation which we do not do locally — we note that clearly).
//   docx  -> mammoth (raw text). Strong.
//   xlsx  -> xlsx (SheetJS) -> CSV-like text per sheet. Strong for simple
//            sheets; complex multi-table / merged-cell semantics are caveated.
//   csv   -> read as text. Strong.
//   pptx  -> jszip + parse slide XML <a:t> runs. Text only; diagram-heavy decks
//            are caveated.
//   image -> tesseract.js OCR, optionally an LLM-vision pass for captioning /
//            handwriting where a vision-capable LLM is configured.
//
// Everything is best-effort and returns a structured result so the ingestion
// pipeline + review UI can show exactly what happened (method, ocrUsed, notes).
// ---------------------------------------------------------------------------

export type SourceFileType =
  | "pdf"
  | "docx"
  | "xlsx"
  | "csv"
  | "pptx"
  | "image"
  | "text"
  | "unknown";

export interface ExtractionResult {
  text: string;
  ocrUsed: boolean;
  method: string;
  note?: string;
  /** Soft-fail: true if extraction produced little/no usable text. */
  lowConfidence: boolean;
  /**
   * For scanned/image-only PDFs (no text layer): the rendered page images.
   * Ingestion embeds these directly with voyage-multimodal-3.5 (no costly OCR),
   * so the pages are vector-searchable cross-modally. Each entry is PNG bytes.
   */
  pageImages?: Buffer[];
}

export function detectFileType(
  fileName: string,
  mimeType?: string
): SourceFileType {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "docx" || mimeType?.includes("wordprocessingml")) return "docx";
  if (ext === "xlsx" || ext === "xls" || mimeType?.includes("spreadsheetml"))
    return "xlsx";
  if (ext === "csv" || mimeType === "text/csv") return "csv";
  if (ext === "pptx" || mimeType?.includes("presentationml")) return "pptx";
  if (
    ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"].includes(ext) ||
    mimeType?.startsWith("image/")
  )
    return "image";
  if (["txt", "md", "json"].includes(ext) || mimeType?.startsWith("text/"))
    return "text";
  return "unknown";
}

// --- individual extractors --------------------------------------------------

/**
 * pdf-parse v2 uses pdf.js (pdfjs-dist), which references browser globals like
 * DOMMatrix / Path2D / ImageData. These don't exist in the Node.js server
 * runtime, so extraction throws "DOMMatrix is not defined". We polyfill them
 * from @napi-rs/canvas (already a pdf-parse dependency) before pdf.js loads.
 */
async function ensurePdfDomGlobals(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (g.DOMMatrix && g.Path2D && g.ImageData) return;
  try {
    const canvas = await import("@napi-rs/canvas");
    if (!g.DOMMatrix && (canvas as any).DOMMatrix)
      g.DOMMatrix = (canvas as any).DOMMatrix;
    if (!g.Path2D && (canvas as any).Path2D) g.Path2D = (canvas as any).Path2D;
    if (!g.ImageData && (canvas as any).ImageData)
      g.ImageData = (canvas as any).ImageData;
  } catch {
    /* if the shim isn't available, pdf-parse will surface its own error */
  }
}

/**
 * pdf-parse inserts page separators like "-- 1 of 12 --". These inflate the
 * text length and can mask a PDF that actually has NO real text layer (scanned
 * / image-only). Strip them to measure the genuine extractable text.
 */
function stripPdfPageMarkers(text: string): string {
  return text
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rasterise every page of a PDF to PNG buffers so image-only/scanned PDFs can
 * be OCR'd. Uses pdfjs + @napi-rs/canvas, with pdfjs' bundled standard fonts so
 * text-layer glyphs (if any) still render. Best-effort; returns [] on failure.
 */
async function rasterizePdfPages(
  buf: Buffer,
  maxPages = 20
): Promise<Buffer[]> {
  try {
    await ensurePdfDomGlobals();
    const canvas = await import("@napi-rs/canvas");
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

    let standardFontDataUrl: string | undefined;
    try {
      const path = await import("path");
      const fs = await import("fs");
      const candidates = [
        path.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts") + "/",
      ];
      const dir = candidates.find((p) => fs.existsSync(p));
      if (dir) standardFontDataUrl = "file://" + dir;
    } catch {
      /* best effort */
    }

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
      isEvalSupported: false,
      standardFontDataUrl,
    }).promise;

    const pages: Buffer[] = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const c = canvas.createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx as any, viewport }).promise;
      pages.push(c.toBuffer("image/png"));
    }
    return pages;
  } catch {
    return [];
  }
}

// Singleton PaddleOCR (ONNX) instance — models are loaded once and reused.
let onnxOcrPromise: Promise<any> | null = null;
async function getOnnxOcr(): Promise<any> {
  if (!onnxOcrPromise) {
    onnxOcrPromise = (async () => {
      const path = await import("path");
      const fs = await import("fs");
      const Ocr = ((await import("@gutenye/ocr-node")) as any).default;
      // Resolve bundled PP-OCRv4 models. Prefer an explicit override, else the
      // node_modules assets dir (also copied into the standalone image).
      const dirs = [
        env.onnxOcrModelsDir,
        path.join(process.cwd(), "node_modules/@gutenye/ocr-models/assets"),
      ].filter(Boolean) as string[];
      const modelsDir = dirs.find((d) => {
        try {
          return fs.existsSync(path.join(d, "ch_PP-OCRv4_det_infer.onnx"));
        } catch {
          return false;
        }
      });
      if (!modelsDir) throw new Error("PaddleOCR ONNX models not found");
      return Ocr.create({
        models: {
          detectionPath: path.join(modelsDir, "ch_PP-OCRv4_det_infer.onnx"),
          recognitionPath: path.join(modelsDir, "ch_PP-OCRv4_rec_infer.onnx"),
          dictionaryPath: path.join(modelsDir, "ppocr_keys_v1.txt"),
        },
      });
    })();
  }
  return onnxOcrPromise;
}

/**
 * Local OCR with PaddleOCR PP-OCRv4 via ONNX runtime — high CJK accuracy, no
 * Python, no per-page API cost. Models load once (singleton). Each page image
 * is written to a temp file (the lib reads by path). Returns per-page text.
 */
async function ocrPagesOnnx(pages: Buffer[]): Promise<string[]> {
  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs/promises");
  const ocr = await getOnnxOcr();
  const perPage: string[] = new Array(pages.length).fill("");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
  try {
    for (let i = 0; i < pages.length; i++) {
      const f = path.join(dir, `p${i}.png`);
      try {
        await fs.writeFile(f, pages[i]);
        const lines: any[] = await ocr.detect(f);
        perPage[i] = (lines ?? [])
          .map((l) => l.text)
          .join("\n")
          .trim();
      } catch {
        /* page OCR failed */
      } finally {
        try {
          await fs.unlink(f);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    try {
      await fs.rmdir(dir);
    } catch {
      /* ignore */
    }
  }
  return perPage;
}

/**
 * Local OCR with a POOLED Tesseract worker: the language models are loaded ONCE
 * and reused across all pages (a fresh worker per page is what makes naive
 * Tesseract slow). Free, local, no per-page API cost — scales to many pages.
 * Returns per-page text in order.
 */
async function ocrPagesTesseract(pages: Buffer[]): Promise<string[]> {
  const perPage: string[] = new Array(pages.length).fill("");
  const Tesseract: any = await import("tesseract.js");
  const createWorker = Tesseract.createWorker ?? Tesseract.default?.createWorker;

  let worker: any = null;
  try {
    // langPath points at the working dir where the *.traineddata files live.
    worker = await createWorker(env.ocrLangs, undefined, {
      langPath: process.cwd(),
      gzip: false,
    });
  } catch {
    // Older/newer API shapes: fall back to per-call recognize.
    worker = null;
  }

  try {
    if (worker) {
      for (let i = 0; i < pages.length; i++) {
        try {
          const { data } = await worker.recognize(pages[i]);
          perPage[i] = (data.text ?? "").trim();
        } catch {
          /* page OCR failed */
        }
      }
    } else {
      const recognize = Tesseract.recognize ?? Tesseract.default?.recognize;
      for (let i = 0; i < pages.length; i++) {
        try {
          const { data } = await recognize(pages[i], env.ocrLangs);
          perPage[i] = (data.text ?? "").trim();
        } catch {
          /* page OCR failed */
        }
      }
    }
  } finally {
    try {
      await worker?.terminate?.();
    } catch {
      /* ignore */
    }
  }
  return perPage;
}

/**
 * OCR a set of rasterised page images to text. Default engine is LOCAL Tesseract
 * (free, fast enough for many pages via a pooled worker). Set OCR_ENGINE=vision
 * to use the vision LLM instead (higher accuracy, but costly/slow at scale).
 * Exposed so scanned PDFs can be OCR'd on upload or on demand.
 */
export async function ocrPageImages(
  pages: Buffer[]
): Promise<{ text: string; method: string }> {
  let perPage: string[];
  let engine: string;

  if (env.ocrEngine === "vision" && hasVisionLLM()) {
    engine = "llm-vision";
    perPage = new Array(pages.length).fill("");
    const CONCURRENCY = 8;
    for (let start = 0; start < pages.length; start += CONCURRENCY) {
      const batch = pages.slice(start, start + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (p) => {
          try {
            return await llmVisionExtract(p, "image/png");
          } catch {
            return "";
          }
        })
      );
      results.forEach((r, j) => (perPage[start + j] = r));
    }
  } else if (env.ocrEngine === "onnx") {
    // PaddleOCR PP-OCRv4 via ONNX. Fall back to Tesseract if it fails to load.
    try {
      engine = "paddle-onnx";
      perPage = await ocrPagesOnnx(pages);
    } catch {
      engine = "tesseract";
      perPage = await ocrPagesTesseract(pages);
    }
  } else {
    engine = "tesseract";
    perPage = await ocrPagesTesseract(pages);
  }

  const text = perPage
    .map((txt, i) => (txt ? `[Page ${i + 1}]\n${txt}` : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return {
    text,
    method: `pdf-rasterise+${engine}`,
  };
}

/** Rasterise a scanned PDF's pages for on-demand OCR (used by the OCR action). */
export async function rasterizePdfForOcr(buf: Buffer): Promise<Buffer[]> {
  return rasterizePdfPages(buf, env.pdfOcrMaxPages);
}

async function extractPdf(
  buf: Buffer,
  opts: { ocr?: boolean } = {}
): Promise<ExtractionResult> {
  let text = "";
  try {
    // Polyfill browser globals pdf.js expects before importing pdf-parse.
    await ensurePdfDomGlobals();
    // pdf-parse v2 exposes a PDFParse class with getText().
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const data = await parser.getText();
    await parser.destroy();
    text = (data.text ?? "").trim();
    // Measure REAL text (excluding page-separator markers).
    const realText = stripPdfPageMarkers(text);
    if (realText.length >= env.ocrMinChars) {
      return { text, ocrUsed: false, method: "pdf-parse", lowConfidence: false };
    }
    // else: no usable text layer -> scanned/image-only PDF.
  } catch (e) {
    text = "";
  }

  // --- Scanned / image-only PDF ---
  const pages = await rasterizePdfPages(buf, env.pdfOcrMaxPages);
  if (!pages.length) {
    return {
      text,
      ocrUsed: false,
      method: "pdf-parse",
      lowConfidence: true,
      note: "PDF has no extractable text layer and page rasterisation failed.",
    };
  }

  // Scanned/image-only PDF. By default we run LOCAL OCR (Tesseract) on upload so
  // the text is keyword- AND vector-searchable, and ALSO return the page images
  // so ingestion can add a multimodal image embedding (cross-modal fallback).
  // Set PDF_OCR_ON_UPLOAD=false to skip OCR on upload (image-embed only; OCR on
  // demand). opts.ocr forces OCR regardless.
  const doOcr = opts.ocr || env.pdfOcrOnUpload;
  if (!doOcr) {
    return {
      text: "",
      ocrUsed: false,
      method: "pdf-rasterise+multimodal",
      lowConfidence: false, // page-image embedding makes it searchable
      note: `Scanned/image-only PDF — ${pages.length} page(s) embedded as images (voyage-multimodal). Run OCR to extract readable text for keyword search.`,
      pageImages: pages,
    };
  }

  const { text: ocrText, method } = await ocrPageImages(pages);
  const usable = stripPdfPageMarkers(ocrText).length >= env.ocrMinChars;
  return {
    text: ocrText,
    ocrUsed: true,
    method,
    // Even if OCR text is thin, keep the page images so vector search still works.
    lowConfidence: !usable,
    note: `Scanned/image-only PDF — OCR'd ${pages.length} page(s) via ${method.replace(
      "pdf-rasterise+",
      ""
    )} (keyword-searchable) + page-image embedding.`,
    pageImages: pages,
  };
}

async function extractDocx(buf: Buffer): Promise<ExtractionResult> {
  try {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const text = (value ?? "").trim();
    return {
      text,
      ocrUsed: false,
      method: "mammoth",
      lowConfidence: text.length < env.ocrMinChars,
    };
  } catch (e) {
    return {
      text: "",
      ocrUsed: false,
      method: "mammoth",
      lowConfidence: true,
      note: `DOCX extraction failed: ${(e as Error).message}`,
    };
  }
}

async function extractSpreadsheet(
  buf: Buffer,
  type: "xlsx" | "csv"
): Promise<ExtractionResult> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) parts.push(`# Sheet: ${name}\n${csv.trim()}`);
    }
    const text = parts.join("\n\n").trim();
    return {
      text,
      ocrUsed: false,
      method: type === "csv" ? "sheetjs(csv)" : "sheetjs(xlsx)",
      lowConfidence: text.length < env.ocrMinChars,
      note:
        wb.SheetNames.length > 1
          ? "Multiple sheets flattened to CSV text. Complex Excel semantics (formulas, merged cells, pivots) are not interpreted — partial support."
          : undefined,
    };
  } catch (e) {
    return {
      text: "",
      ocrUsed: false,
      method: "sheetjs",
      lowConfidence: true,
      note: `Spreadsheet extraction failed: ${(e as Error).message}`,
    };
  }
}

async function extractPptx(buf: Buffer): Promise<ExtractionResult> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml/)![1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml/)![1], 10);
        return na - nb;
      });
    const out: string[] = [];
    for (let i = 0; i < slidePaths.length; i++) {
      const xml = await zip.files[slidePaths[i]].async("string");
      // Pull text runs: <a:t>...</a:t>
      const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
        m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      );
      if (runs.length) out.push(`# Slide ${i + 1}\n${runs.join(" ")}`);
    }
    const text = out.join("\n\n").trim();
    return {
      text,
      ocrUsed: false,
      method: "jszip(pptx-xml)",
      lowConfidence: text.length < env.ocrMinChars,
      note: "Slide text runs only. Diagram-heavy / image-only slides are not OCR'd here — partial support.",
    };
  } catch (e) {
    return {
      text: "",
      ocrUsed: false,
      method: "jszip(pptx-xml)",
      lowConfidence: true,
      note: `PPTX extraction failed: ${(e as Error).message}`,
    };
  }
}

/** Best-effort image MIME from magic bytes, falling back to a supplied hint. */
function sniffImageMime(buf: Buffer, hint?: string): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50)
    return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buf.length >= 6) {
    const g = buf.toString("ascii", 0, 6);
    if (g === "GIF87a" || g === "GIF89a") return "image/gif";
  }
  if (hint && hint.startsWith("image/")) return hint;
  return "image/png";
}

async function extractImageOcr(
  buf: Buffer,
  mimeType?: string
): Promise<ExtractionResult> {
  let ocrText = "";
  let ocrNote: string | undefined;
  try {
    const Tesseract = await import("tesseract.js");
    const { data } = await Tesseract.recognize(buf, env.ocrLangs);
    ocrText = (data.text ?? "").trim();
  } catch (e) {
    ocrNote = `Tesseract OCR failed: ${(e as Error).message}`;
  }

  // LLM-vision assist: when configured, ask the model to transcribe + caption.
  // This greatly helps handwriting / stamps / labelled diagrams that Tesseract
  // mangles. It augments, not replaces, the OCR text.
  let visionText = "";
  if (hasVisionLLM()) {
    try {
      visionText = await llmVisionExtract(buf, sniffImageMime(buf, mimeType));
    } catch (e) {
      ocrNote = `${ocrNote ? ocrNote + " " : ""}LLM vision pass failed: ${
        (e as Error).message
      }`;
    }
  }

  const combined = [
    ocrText && `[OCR]\n${ocrText}`,
    visionText && `[LLM vision transcription / caption]\n${visionText}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    text: combined,
    ocrUsed: true,
    method: visionText ? "tesseract+llm-vision" : "tesseract",
    lowConfidence: combined.length < env.ocrMinChars,
    note:
      ocrNote ??
      (visionText
        ? "OCR text augmented with an LLM vision transcription/caption."
        : "Tesseract OCR. For handwriting / diagrams, configure a vision-capable LLM for better results."),
  };
}

/** Send an image to the configured (OpenAI-compatible) LLM for transcription. */
async function llmVisionExtract(buf: Buffer, mime = "image/png"): Promise<string> {
  const b64 = buf.toString("base64");
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
            "You are an expert transcriber of property-management documents, including HANDWRITTEN forms, notes, stamps and labelled diagrams, in English and Traditional/Simplified Chinese. " +
            "Transcribe ALL text verbatim, preserving layout order, line breaks and field labels (e.g. 'Date: ___', 'Signature: ___'). " +
            "For handwriting: read carefully character-by-character; render your single best reading. If a token is genuinely illegible, write [illegible] rather than guessing or inventing content. " +
            "Preserve numbers, dates, units and currency exactly. After the transcription, add one line starting 'Caption:' describing any diagram/floor-plan/signature/stamp. Do not add commentary.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe every piece of text in this image verbatim (handwritten and printed), then give a one-line caption.",
            },
            {
              type: "image_url",
              // Real MIME + high detail markedly improves handwriting reads.
              image_url: {
                url: `data:${mime};base64,${b64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

// --- dispatcher -------------------------------------------------------------

export async function extractText(
  buf: Buffer,
  fileName: string,
  mimeType?: string,
  opts: { pdfOcr?: boolean } = {}
): Promise<ExtractionResult & { fileType: SourceFileType }> {
  const fileType = detectFileType(fileName, mimeType);
  let result: ExtractionResult;
  switch (fileType) {
    case "pdf":
      result = await extractPdf(buf, { ocr: opts.pdfOcr });
      break;
    case "docx":
      result = await extractDocx(buf);
      break;
    case "xlsx":
      result = await extractSpreadsheet(buf, "xlsx");
      break;
    case "csv":
      result = await extractSpreadsheet(buf, "csv");
      break;
    case "pptx":
      result = await extractPptx(buf);
      break;
    case "image":
      result = await extractImageOcr(buf, mimeType);
      break;
    case "text":
      result = {
        text: buf.toString("utf-8").trim(),
        ocrUsed: false,
        method: "utf-8",
        lowConfidence: false,
      };
      break;
    default:
      result = {
        text: "",
        ocrUsed: false,
        method: "none",
        lowConfidence: true,
        note: "Unsupported file type. Supported: PDF, DOCX, XLSX/CSV, PPTX, images, text.",
      };
  }
  return { ...result, fileType };
}
