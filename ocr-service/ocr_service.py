"""
PaddleOCR HTTP microservice (backend-separated OCR).

Purpose
-------
A small, standalone FastAPI service whose ONLY job is OCR + layout analysis.
It does NOT touch the business database, does NOT do embeddings, and knows
nothing about the property-management domain. The Node.js app calls it over
HTTP and does its own block reordering / text assembly / persistence.

Why a separate service?
-----------------------
The existing in-Node OCR (Tesseract / PP-OCRv4 via ONNX) has no layout
direction analysis, so mixed horizontal + vertical handwritten Chinese/English
forms come back with a scrambled reading order, which corrupts the embedding
semantics. Running full PaddleOCR (with angle classification + layout) in an
isolated Python process gives much better mixed-orientation results without
embedding a heavy Python runtime into the Node app.

Endpoints
---------
  GET  /health  -> readiness probe
  POST /ocr     -> multipart/form-data { file: <jpg|png> } -> blocks[]

Response shape (per block):
  {
    "bbox": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]],   # 4-point polygon
    "direction": "vertical" | "horizontal",
    "angle": 0.0..180.0,                          # dominant text-line angle (deg)
    "text": "...",
    "confidence": 0.0..1.0
  }

The top-level response also includes `imageWidth` / `imageHeight` — the size of
the ORIGINAL image the bbox coordinates are relative to. Doc orientation/unwarp
is DISABLED so those coordinates match the original upload exactly (the Node side
crops handwritten-name regions from that same original).

`angle` is the orientation of the text baseline derived from the bbox polygon
(0 deg = horizontal, ~90 deg = vertical). The Node side uses it — together with
confidence and bbox position — to decide which blocks are HANDWRITTEN name
candidates that need a multimodal re-read. This service does NOT itself decide
what is handwriting; it only reports geometry + confidence.

Port
----
Read from the OCR_SERVICE_PORT env var. NEVER hard-coded (8000 is taken by
another local demo). The Node side reads OCR_SERVICE_URL from its own env.
"""

import io
import os
import math
import logging

import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from PIL import Image

# Quiet PaddleOCR / ppocr chatter so the service log stays clean.
logging.getLogger("ppocr").setLevel(logging.ERROR)
os.environ.setdefault("FLAGS_call_stack_level", "2")

from paddleocr import PaddleOCR  # noqa: E402  (import after log config)

app = FastAPI(title="PaddleOCR Layout Service", version="paddle_layout_v1")

# ---------------------------------------------------------------------------
# Single PaddleOCR instance, created once at startup and reused across requests.
#   use_angle_cls=True  -> rotate/angle classification (handles rotated text)
#   lang="ch"           -> Chinese model; also recognises Latin/English glyphs
#   use_layout=True     -> layout analysis (kept on to aid mixed layouts)
# We pass the layout flag defensively: some PaddleOCR builds accept it on the
# constructor, others only on the call, and very new ones renamed it. We try
# the richest constructor and gracefully fall back.
# ---------------------------------------------------------------------------
_ocr = None


def _build_ocr() -> PaddleOCR:
    """Construct a PaddleOCR instance across 2.x and 3.x APIs.

    3.x renamed `use_angle_cls` -> `use_textline_orientation` and dropped
    `show_log`. 2.x used `use_angle_cls` (+ optional `use_layout`). We try the
    richest known-good signatures first and fall back progressively.

    IMPORTANT (coordinate system): PaddleOCR 3.x runs a document
    orientation-classify + unwarp (UVDoc) stage BEFORE detection. On a rotated
    phone-photo / scan of a vertical HK form it silently ROTATES the page, so
    the returned bbox coordinates land in the *corrected* image's coordinate
    system — which no longer matches the ORIGINAL image the Node side crops from.
    That made every handwritten-name crop land on blank/misaligned pixels.
    We DISABLE both stages so bbox coordinates are always relative to the ORIGINAL
    uploaded image, keeping the Node-side crop perfectly aligned.
    """
    attempts = [
        # PaddleOCR 3.x — disable doc orientation/unwarp so bbox == original img.
        dict(
            use_textline_orientation=True,
            lang="ch",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
        ),
        # 3.x without the disable kwargs (older 3.x builds).
        dict(use_textline_orientation=True, lang="ch"),
        # PaddleOCR 2.x with layout
        dict(use_angle_cls=True, lang="ch", show_log=False, use_layout=True),
        # PaddleOCR 2.x
        dict(use_angle_cls=True, lang="ch", show_log=False),
        # Minimal
        dict(lang="ch"),
    ]
    last_err = None
    for kwargs in attempts:
        try:
            return PaddleOCR(**kwargs)
        except (TypeError, ValueError) as exc:
            last_err = exc
            continue
    raise RuntimeError(f"could not construct PaddleOCR: {last_err}")


def _run_ocr(image) -> object:
    """Run OCR across 3.x `.predict()` and 2.x `.ocr()` APIs."""
    # 3.x preferred entrypoint.
    if hasattr(_ocr, "predict"):
        try:
            return _ocr.predict(image)
        except Exception:  # noqa: BLE001 -- fall through to legacy .ocr()
            pass
    # 2.x with optional angle classification kwarg.
    try:
        return _ocr.ocr(image, cls=True)
    except TypeError:
        return _ocr.ocr(image)


@app.on_event("startup")
def _startup() -> None:
    global _ocr
    _ocr = _build_ocr()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "ready": _ocr is not None, "version": "paddle_layout_v1"}


def _direction(bbox) -> str:
    """Classify a block as vertical vs horizontal from its bbox geometry.

    Rule (matches the Node side): height > width * 1.5 -> vertical, else
    horizontal. bbox is a 4-point polygon [[x0,y0]..[x3,y3]].
    """
    xs = [float(p[0]) for p in bbox]
    ys = [float(p[1]) for p in bbox]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    return "vertical" if height > width * 1.5 else "horizontal"


def _angle(bbox) -> float:
    """Dominant text-line angle (degrees, 0..180) from the bbox polygon.

    PaddleOCR returns points in reading order, so the top edge p0->p1 tracks the
    baseline direction. We take that edge's inclination; if the box is taller
    than wide (a vertical column) we report ~90 deg so the Node side can treat it
    as a rotated / vertical candidate. Falls back to the geometric aspect when
    the polygon is degenerate.
    """
    try:
        (x0, y0), (x1, y1) = bbox[0], bbox[1]
        edge_angle = abs(math.degrees(math.atan2(y1 - y0, x1 - x0)))
        if edge_angle > 90.0:  # normalise to 0..90 baseline inclination
            edge_angle = 180.0 - edge_angle
    except (TypeError, ValueError, IndexError, ZeroDivisionError):
        edge_angle = 0.0

    xs = [float(p[0]) for p in bbox]
    ys = [float(p[1]) for p in bbox]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    # A clearly vertical column reads as ~90 deg regardless of a near-flat edge.
    if height > width * 1.5:
        return 90.0
    return edge_angle


def _append_block(blocks: list, poly_src, text: str, conf: float) -> None:
    try:
        poly = [[float(p[0]), float(p[1])] for p in poly_src][:4]
    except (TypeError, ValueError, IndexError):
        return
    if len(poly) < 4:
        return
    blocks.append(
        {
            "bbox": poly,
            "direction": _direction(poly),
            "angle": round(_angle(poly), 2),
            "text": text,
            "confidence": conf,
        }
    )


def _as_dict(res):
    """Coerce a PaddleOCR 3.x result object into a plain dict.

    3.x `.predict()` returns OCRResult objects that support mapping-style access
    (res["rec_texts"]) and expose the payload under `.json` on some builds.
    """
    if isinstance(res, dict):
        return res
    # Some builds: res.json -> { "res": {...} } or the payload directly.
    payload = getattr(res, "json", None)
    if isinstance(payload, dict):
        return payload.get("res", payload)
    # Fallback: try mapping-style access for the known keys.
    out = {}
    for key in ("rec_texts", "rec_scores", "dt_polys", "rec_polys", "boxes"):
        try:
            out[key] = res[key]  # type: ignore[index]
        except Exception:  # noqa: BLE001
            pass
    return out


def _normalize_result(raw) -> list:
    """Normalise PaddleOCR output (2.x `.ocr()` or 3.x `.predict()`) to blocks."""
    blocks: list = []
    if not raw:
        return blocks

    # Classic 2.x shape: list -> page 0 -> [ [bbox, (text, conf)], ... ]
    if isinstance(raw, list) and raw and isinstance(raw[0], list):
        for line in raw[0] or []:
            try:
                bbox, meta = line[0], line[1]
                _append_block(blocks, bbox, meta[0], float(meta[1]))
            except (IndexError, TypeError, ValueError):
                continue
        return blocks

    # 3.x `.predict()` shape: list of OCRResult / dict, each with parallel arrays.
    if isinstance(raw, list) and raw:
        res = _as_dict(raw[0])
        texts = res.get("rec_texts") or res.get("rec_text") or []
        scores = res.get("rec_scores") or res.get("rec_score") or []
        polys = (
            res.get("dt_polys")
            or res.get("rec_polys")
            or res.get("boxes")
            or []
        )
        for i, text in enumerate(texts):
            poly_src = polys[i] if i < len(polys) else None
            if poly_src is None:
                continue
            conf = float(scores[i]) if i < len(scores) else 0.0
            _append_block(blocks, poly_src, text, conf)
        return blocks

    return blocks


@app.post("/ocr")
async def ocr(file: UploadFile = File(...)) -> dict:
    if _ocr is None:
        raise HTTPException(status_code=503, detail="OCR engine not ready")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid image: {exc}")

    img = np.array(image)
    # Height, width of the ORIGINAL image actually passed to OCR. Because we
    # disabled doc orientation/unwarp, bbox coordinates are relative to THIS
    # image — the Node side crops from the same original, so they align.
    height, width = int(img.shape[0]), int(img.shape[1])

    raw = _run_ocr(img)
    blocks = _normalize_result(raw)
    return {"blocks": blocks, "imageWidth": width, "imageHeight": height}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OCR_SERVICE_PORT", "0"))
    if not port:
        raise SystemExit(
            "OCR_SERVICE_PORT is not set. Refusing to hard-code a port "
            "(8000 is used by another local demo). Set it in the environment, "
            "e.g. OCR_SERVICE_PORT=8001."
        )
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
