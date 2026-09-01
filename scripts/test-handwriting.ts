// Standalone test: run the full image OCR + multimodal handwritten-name pass
// against a local file, WITHOUT touching MongoDB. Verifies requirement 1-4/6.
//
//   npx tsx scripts/test-handwriting.ts "demo image/chinese_ta_photo.jpg"
//
// Loads .env, but overrides OCR_SERVICE_URL to the host-mapped port (the .env
// value points at the Docker-internal hostname `ocr`, unreachable from here).
import "./_loadEnv";
import { resolve } from "path";

// MUST override before importing anything that reads env (env.ts snapshots it).
process.env.OCR_SERVICE_URL =
  process.env.OCR_SERVICE_URL_LOCAL ?? "http://127.0.0.1:8001/ocr";
process.env.USE_EXTERNAL_PADDLE_OCR = "true";

async function main() {
  const fs = await import("fs/promises");
  const { extractText } = await import("../src/lib/extract");
  const { hasExternalPaddleOcr, hasVisionLLM, env } = await import(
    "../src/lib/env"
  );

  const file = process.argv[2] || "demo image/chinese_ta_photo.jpg";
  const abs = resolve(process.cwd(), file);
  const buf = await fs.readFile(abs);
  const fileName = file.split("/").pop() || "upload.jpg";

  console.log("=".repeat(70));
  console.log("測試檔案:", file, `(${(buf.length / 1024).toFixed(0)} KB)`);
  console.log("OCR_SERVICE_URL:", env.ocrServiceUrl);
  console.log("外部 PaddleOCR 已啟用:", hasExternalPaddleOcr());
  console.log("視覺 LLM 已配置:", hasVisionLLM(), `(${env.llmModel})`);
  console.log("=".repeat(70));

  const t0 = Date.now();
  const r = await extractText(buf, fileName, "image/jpeg");
  const ms = Date.now() - t0;

  console.log("\n耗時:", ms + "ms");
  console.log("method:", r.method);
  console.log("ocrUsed:", r.ocrUsed, "| lowConfidence:", r.lowConfidence);
  console.log("note:", r.note);
  console.log("OCR blocks 總數:", r.ocr?.blocks?.length ?? 0);

  const names = r.extractedHandwrittenNames ?? [];
  console.log("\n" + "-".repeat(70));
  console.log(`提取到的手寫姓名 (${names.length} 個):`);
  console.log("-".repeat(70));
  if (!names.length) {
    console.log("  (沒有偵測到手寫姓名候選)");
  } else {
    names.forEach((n, i) => {
      const cx =
        n.bbox && n.bbox.length
          ? Math.round(n.bbox.reduce((s, p) => s + p[0], 0) / n.bbox.length)
          : "?";
      const cy =
        n.bbox && n.bbox.length
          ? Math.round(n.bbox.reduce((s, p) => s + p[1], 0) / n.bbox.length)
          : "?";
      console.log(
        `  [${i}] "${n.nameText}"  lang=${n.lang}  ` +
          `原始信心=${n.sourceConfidence?.toFixed(2)}  中心=(${cx},${cy})`
      );
    });
  }

  console.log("\n" + "-".repeat(70));
  console.log("fullText (前 800 字，供嵌入用):");
  console.log("-".repeat(70));
  console.log((r.text || "").slice(0, 800));
}

main().catch((e) => {
  console.error("測試失敗:", e);
  process.exit(1);
});
