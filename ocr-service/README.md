# PaddleOCR microservice (backend-separated OCR)

A small standalone **Python FastAPI** service that does OCR + layout analysis
with **PaddleOCR** (`use_angle_cls=True`, `lang="ch"`, layout on). It is
deliberately isolated from the Node.js app: **no DB, no embeddings, no business
logic** — it only turns an image into OCR blocks. The Node app calls it over
HTTP and does its own block reordering / text assembly / persistence.

This exists because the in-Node OCR had no layout-direction analysis, so mixed
**horizontal + vertical handwritten** Chinese/English forms came back with a
scrambled reading order, corrupting embedding semantics.

## Multilingual handwritten-name recognition (HK tenancy signatures)

HK tenancy signatures come in three shapes: handwritten Traditional Chinese,
handwritten English, or a **mixed** zh+en signature block. We do **not** deploy
separate zh / en handwriting models. The pipeline is split by responsibility:

1. **This service** only detects text regions and reports each block's `bbox`,
   `direction`, `angle` and `confidence`. Printed body text with
   `confidence > 0.6` is used verbatim.
2. **Node** (`src/lib/ocrUtils.ts → findHandwrittenNameCandidates`) flags a block
   as a handwritten-name candidate when it looks handwritten (`angle ≈ 90°` **or**
   `confidence ≤ 0.6`) **and** sits in a signature-prone region (top-right corner
   or the bottom third of the page).
3. **Node** (`src/lib/handwriting.ts → recognizeHandwrittenNames`) crops each
   candidate to a small local image and sends it to **one multimodal model**
   that transcribes zh / en / mixed names automatically — no per-language call.
4. The reading back-fills `block.text` and is stored at the document top level as
   `extractedHandwrittenNames[] = { nameText, lang }` (`lang ∈ zh|en|mixed`).
5. `extractedHandwrittenNames.nameText` is indexed by **Atlas Search** with a
   CJK analyzer + a Latin multi-analyzer, so a tenancy is recalled by the
   tenant's Chinese **or** English name (`atlas-indexes/lexical_index.json`).
6. If a name is genuinely illegible, `block.text` becomes
   `"[無法識別手寫姓名]"` and the block (with its `bbox`) is **kept, never dropped**.

Enable it with `USE_EXTERNAL_PADDLE_OCR=true` **and** a vision-capable LLM
(`LLM_*` / `OPENAI_*`). Without a vision LLM the handwriting pass is a no-op and
printed OCR is unaffected.

## Port (never hard-coded)

The port comes from `OCR_SERVICE_PORT` (8000 is taken by another local demo).
The Node side reads `OCR_SERVICE_URL` from its own `.env`.

## Setup

```bash
cd ocr-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
# Uses OCR_SERVICE_PORT from the environment or the parent ../.env
OCR_SERVICE_PORT=8001 ./run.sh
# or:
OCR_SERVICE_PORT=8001 python ocr_service.py
```

Health check: `curl http://127.0.0.1:8001/health`

## API

`POST /ocr` — `multipart/form-data`, field `file` (jpg/png). Returns:

```json
{
  "blocks": [
    {
      "bbox": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]],
      "direction": "vertical",
      "angle": 90.0,
      "text": "...",
      "confidence": 0.98
    }
  ]
}
```

`angle` is the text-line inclination in degrees (0 = horizontal, ~90 =
vertical/rotated). The Node app uses `angle` + `confidence` + bbox position to
pick out **handwritten name candidates** (rotated signatures, low-confidence
strokes in the top-right / signature area) and re-reads only those crops with a
multimodal model. The service stays pure OCR + layout — it never crops, calls a
vision model, or touches the database.

## Node side

Set in the project `.env`:

```
USE_EXTERNAL_PADDLE_OCR=true
# local (npm run dev):
OCR_SERVICE_URL=http://127.0.0.1:8001/ocr
# Docker (app in a container, OCR service on the host):
# OCR_SERVICE_URL=http://host.docker.internal:8001/ocr
```
