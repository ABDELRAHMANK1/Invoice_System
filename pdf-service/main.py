"""
main.py — FastAPI app exposing /pdf-to-image and /parse-invoice on :5000.

Endpoints
---------
POST /pdf-to-image  →  raw PDF body (application/pdf) OR multipart "file" field
                       returns {"image": "<base64 PNG>", "format": "png"}.
POST /parse-invoice →  form-data with "text" field
                       returns the structured invoice dict from invoice_parser.

The PDF renderer uses PyMuPDF (fitz) because it ships everything in-process
(no Poppler / system-level dependency), which keeps the systemd unit simple
on Ubuntu 24.04. If your existing deploy uses pdf2image instead, replace the
pdf_to_image handler body and leave the rest unchanged.
"""
from __future__ import annotations

import base64
import io
import logging
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile

from invoice_parser import parse_invoice

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("pdf-service")

app = FastAPI(title="Oranji PDF Service", version="2026.06.14")


# ── PDF → image ──────────────────────────────────────────────────────────────

# 300 DPI (was 200) — sharper glyphs help GPT-4o vision / OCR on scanned PDFs.
_RENDER_DPI = 300
# Contrast multiplier applied before returning, to lift faded scans.
_CONTRAST_FACTOR = 1.5
# Below this fraction of non-white pixels a page is treated as blank/low-content.
_BLANK_CONTENT_THRESHOLD = 0.005


def _render_page_png(page, dpi: int = _RENDER_DPI) -> bytes:
    import fitz  # PyMuPDF (already imported by caller; re-import is cached)
    matrix = fitz.Matrix(dpi / 72.0, dpi / 72.0)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    return pix.tobytes("png")


def _content_fraction(png_bytes: bytes) -> float:
    """Fraction of non-white pixels — a cheap blank/low-content detector.

    Returns 1.0 (assume content) if Pillow is unavailable, so detection never
    blocks a render.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover
        return 1.0
    gray = Image.open(io.BytesIO(png_bytes)).convert("L")
    hist = gray.histogram()
    total = sum(hist) or 1
    non_white = sum(hist[:245])  # darker than near-white ⇒ ink / text
    return non_white / total


def _enhance_png(png_bytes: bytes) -> bytes:
    """Boost contrast for crisper text. No-op if Pillow isn't installed."""
    try:
        from PIL import Image, ImageEnhance, ImageOps
    except ImportError:  # pragma: no cover
        return png_bytes
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    img = ImageOps.autocontrast(img, cutoff=1)          # normalise faded scans
    img = ImageEnhance.Contrast(img).enhance(_CONTRAST_FACTOR)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _render_pdf_to_png(pdf_bytes: bytes) -> bytes:
    """Render an invoice PDF page to a contrast-enhanced PNG at 300 DPI.

    Uses page 1 normally, but if page 1 comes back blank/low-content (a common
    scanner artefact: a cover or empty first sheet) it falls back to the page
    with the most ink among the first two.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError as e:  # pragma: no cover
        raise HTTPException(
            status_code=500,
            detail="PyMuPDF (pymupdf) is not installed on the server. "
                   "Run: pip install pymupdf",
        ) from e

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid PDF: {e}") from e

    if doc.page_count == 0:
        doc.close()
        raise HTTPException(status_code=400, detail="PDF has no pages")

    try:
        png = _render_page_png(doc.load_page(0))
        frac = _content_fraction(png)
        if frac < _BLANK_CONTENT_THRESHOLD and doc.page_count > 1:
            logger.info(
                "[pdf-to-image] page 1 looks blank (%.3f%% ink) — trying page 2",
                frac * 100,
            )
            png2 = _render_page_png(doc.load_page(1))
            if _content_fraction(png2) > frac:
                png = png2
        return _enhance_png(png)
    finally:
        doc.close()


@app.post("/pdf-to-image")
async def pdf_to_image(
    request: Request,
    file: Optional[UploadFile] = File(None),
):
    """Accept either a multipart 'file' field OR a raw application/pdf body."""
    if file is not None:
        pdf_bytes = await file.read()
    else:
        pdf_bytes = await request.body()

    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Empty request body")

    png_bytes = _render_pdf_to_png(pdf_bytes)
    b64 = base64.b64encode(png_bytes).decode("ascii")
    return {"image": b64, "format": "png", "size_bytes": len(png_bytes)}


# ── Invoice text → structured fields ──────────────────────────────────────────

@app.post("/parse-invoice")
async def parse_invoice_endpoint(text: str = Form(...)):
    """Parse the supplied invoice text and return the structured field dict."""
    result = parse_invoice(text or "")
    logger.info(
        "[parse-invoice] invoice_number=%s total=%s rate=%s breakdown=%s",
        result.get("invoice_number"),
        result.get("total_amount"),
        result.get("vat_rate"),
        result.get("vat_breakdown"),
    )
    return result


# ── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":  # pragma: no cover — for `python main.py` runs
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5000, log_level="info")
