#!/usr/bin/env bash
# Start the PaddleOCR microservice on the port from OCR_SERVICE_PORT.
# The port is NOT hard-coded (8000 is used by another local demo).
#
# Usage:
#   OCR_SERVICE_PORT=8001 ./run.sh
# or rely on the project's .env (this loads it if present):
#   ./run.sh
set -euo pipefail

cd "$(dirname "$0")"

# Load OCR_SERVICE_PORT from the parent project's .env if not already set.
if [[ -z "${OCR_SERVICE_PORT:-}" && -f "../.env" ]]; then
  line="$(grep -E '^OCR_SERVICE_PORT=' ../.env || true)"
  if [[ -n "$line" ]]; then
    export OCR_SERVICE_PORT="${line#OCR_SERVICE_PORT=}"
    export OCR_SERVICE_PORT="${OCR_SERVICE_PORT//\"/}"
  fi
fi

if [[ -z "${OCR_SERVICE_PORT:-}" ]]; then
  echo "ERROR: OCR_SERVICE_PORT is not set (and not found in ../.env)." >&2
  echo "Set it, e.g.:  OCR_SERVICE_PORT=8001 ./run.sh" >&2
  exit 1
fi

echo "Starting PaddleOCR service on 0.0.0.0:${OCR_SERVICE_PORT}"
exec uvicorn ocr_service:app --host 0.0.0.0 --port "${OCR_SERVICE_PORT}" --log-level warning
