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

def _render_pdf_first_page_to_png(pdf_bytes: bytes) -> bytes:
    """Return PNG bytes for the first page of a PDF, rendered at ~200 DPI."""
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
        page = doc.load_page(0)
        # 200 DPI = scale 200/72 ≈ 2.78× — good legibility for OCR / AI vision.
        matrix = fitz.Matrix(200 / 72.0, 200 / 72.0)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        return pix.tobytes("png")
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

    png_bytes = _render_pdf_first_page_to_png(pdf_bytes)
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
