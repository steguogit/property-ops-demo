/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle in .next/standalone for a small
  // production Docker image (only the files the server actually needs).
  output: "standalone",
  // tesseract.js loads its WASM core (`tesseract.js-core/*.wasm`) via a runtime
  // path, so Next's dependency tracer can't see it and omits it from the
  // standalone output — which makes OCR (image uploads) crash with ENOENT.
  // Force those binaries (plus the tesseract.js worker) into the traced bundle.
  outputFileTracingIncludes: {
    "/api/upload": [
      "./node_modules/tesseract.js-core/**/*.wasm",
      "./node_modules/tesseract.js-core/**/*.wasm.js",
      "./node_modules/tesseract.js/src/worker-script/**/*",
    ],
  },
  experimental: {
    // Keep native / heavy extraction libs out of the server bundle so they
    // load at runtime via require (avoids Next bundling issues with pdf-parse,
    // tesseract.js, sheetjs, etc.).
    serverComponentsExternalPackages: [
      "mongodb",
      "pdf-parse",
      // pdf-parse (pdf.js) needs DOM globals in Node; we polyfill them from
      // @napi-rs/canvas, which ships a native .node binary that must NOT be
      // bundled by webpack — keep it external so it loads via require at runtime.
      "@napi-rs/canvas",
      "pdfjs-dist",
      "mammoth",
      "xlsx",
      "jszip",
      "tesseract.js",
      // PaddleOCR-via-ONNX (OCR_ENGINE=onnx): native onnxruntime + sharp +
      // opencv must load at runtime, not be webpack-bundled.
      "@gutenye/ocr-node",
      "@gutenye/ocr-common",
      "@gutenye/ocr-models",
      "onnxruntime-node",
      "sharp",
      "@techstark/opencv-js",
    ],
  },
};

export default nextConfig;
