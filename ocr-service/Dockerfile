# PaddleOCR microservice image (separate container from the Node app image).
#
# Based on the OFFICIAL paddlepaddle image (paddle pre-installed + verified),
# which avoids the ~2h pip build and the paddlepaddle-2.6.2 arm64 wheel segfault.
# The base is linux/amd64; on Apple Silicon it runs under emulation, where
# paddle 3.0.0 is stable (paddle.utils.run_check passes).
FROM --platform=linux/amd64 paddlepaddle/paddle:3.0.0

WORKDIR /app

# Only PaddleOCR 3.x + the web layer need to be added on top of the base.
# (opencv/numpy/etc. come from the base image.)
# Pin paddleocr to 3.0.x: it targets PP-OCRv5 models that run on paddle 3.0.0.
# Newer paddleocr (3.7) ships PP-OCRv6 models that require a newer paddle and
# fail on 3.0.0 with "Type of attribute: strides is not right".
RUN pip install --no-cache-dir \
    "paddleocr==3.0.3" \
    "paddlex==3.0.3" \
    "fastapi>=0.110" \
    "uvicorn[standard]>=0.29" \
    "python-multipart>=0.0.9" \
    "pillow>=10.0"

# paddlex 3.0.3 imports `langchain.docstore` at module load (a packaging bug);
# provide compatible langchain packages so the import doesn't crash the service.
RUN pip install --no-cache-dir \
    "langchain==0.1.20" \
    "langchain-community==0.0.38"

COPY ocr_service.py ./

# Pre-download the PP-OCRv4/v5 models at build time so the first request isn't
# blocked on a model download. paddle 3.0.0 is stable under emulation, so this
# no longer segfaults (unlike the old 2.6.2 arm64 wheel). Best-effort: never
# fail the build if the model server is briefly unreachable.
RUN python -c "import warnings; warnings.filterwarnings('ignore'); \
from paddleocr import PaddleOCR; PaddleOCR(use_textline_orientation=True, lang='ch')" || \
    echo "model pre-download skipped (will download on first request)"

ENV OCR_SERVICE_PORT=8001
EXPOSE 8001

CMD ["sh", "-c", "uvicorn ocr_service:app --host 0.0.0.0 --port ${OCR_SERVICE_PORT} --log-level warning"]
