# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Property Operations Assistant — production image (Next.js standalone).
#
# Multi-stage build:
#   deps    -> install ALL deps (needed to build)
#   builder -> next build (emits .next/standalone + .next/static)
#   runner  -> minimal runtime with only the standalone server + assets
# ---------------------------------------------------------------------------

# ----- deps -----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ----- builder -----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build with a placeholder so `next build` never fails on a missing var; real
# values are injected at runtime via env_file / -e (Next reads them at runtime
# for server code, not baked in for these server-only vars).
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ----- runner -----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The app's dev/start scripts use port 3100; keep the container consistent.
ENV PORT=3100
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone server + static assets + public files.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Tesseract OCR language data (loaded from the working directory at runtime).
COPY --from=builder --chown=nextjs:nodejs /app/eng.traineddata ./eng.traineddata
COPY --from=builder --chown=nextjs:nodejs /app/chi_sim.traineddata ./chi_sim.traineddata
COPY --from=builder --chown=nextjs:nodejs /app/chi_tra.traineddata ./chi_tra.traineddata

# tesseract.js loads its WASM core dynamically at runtime, which Next's
# standalone file-tracer can miss. Copy the full core package explicitly so OCR
# (image uploads) has its `*.wasm` binaries available.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core

# pdf-parse -> pdf.js (pdfjs-dist) loads its worker (pdf.worker.mjs) dynamically
# at runtime and needs @napi-rs/canvas for DOM-global polyfills. Next's tracer
# misses these, so copy the full packages explicitly for PDF text extraction.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@napi-rs ./node_modules/@napi-rs

# PaddleOCR-via-ONNX engine (OCR_ENGINE=onnx): the OCR runtime, its bundled
# PP-OCRv4 models, and native deps (onnxruntime-node, sharp, opencv) are loaded
# at runtime and missed by the tracer — copy them explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@gutenye ./node_modules/@gutenye
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@techstark ./node_modules/@techstark
# sharp's platform-specific native binaries (@img/*) and onnxruntime binaries.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img

USER nextjs
EXPOSE 3100

# server.js is emitted by Next.js standalone output.
CMD ["node", "server.js"]
