"""
invoice_parser.py — text → structured invoice fields.

Returns the shape documented in main.py's /parse-invoice endpoint:

    {
      "supplier_name": None,
      "client_name":   None,
      "invoice_number": str | None,
      "date":           "YYYY-MM-DD" | None,
      "total_amount":   float,
      "currency":       "EUR" | ...,
      "vat_rate":       0 | 9 | 21,
      "vat_breakdown":  { net_21, vat_21, net_9, vat_9, net_0, emballage },
      "transaction_type": "inkoop",
    }

supplier_name / client_name are left to the AI layer.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Iterable, Optional

logger = logging.getLogger("pdf-service.parser")


# ── Number / date helpers ─────────────────────────────────────────────────────

def parse_number(s: str) -> float:
    """Parse a number string in either Dutch (1.234,56) or English (1,234.56) format."""
    if s is None:
        return 0.0
    s = s.strip().replace(" ", " ").replace("€", "").replace("$", "").replace("£", "")
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"^[^\d\-+]+", "", s)
    s = re.sub(r"[^\d.,]+$", "", s)
    if not s:
        return 0.0
    has_comma = "," in s
    has_dot = "." in s
    if has_comma and has_dot:
        # The last separator is the decimal one (handles both 1.234,56 and 1,234.56)
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif has_comma:
        # Single-comma case is ambiguous. Heuristics, by length of the part
        # after the last comma:
        #   1–2 digits  → decimal ("10,80" → 10.80)
        #   exactly 3   → thousands separator ("1,045" → 1045, US-style)
        #   4+          → high-precision decimal ("15,4455" → 15.4455, common
        #                 in Dutch line-item VAT amounts)
        last = s.split(",")[-1]
        if len(last) == 3:
            s = s.replace(",", "")
        else:
            s = s.replace(".", "").replace(",", ".")
    # else: only dots or only digits — leave as is.
    try:
        return float(s)
    except ValueError:
        return 0.0


def trunc_2(n: float) -> float:
    """Truncate (not round) to 2 decimal places, matching the upstream Excel format."""
    if n is None:
        return 0.0
    return int(n * 100) / 100.0


def normalise_date(year: int, month: int, day: int) -> Optional[str]:
    try:
        return datetime(year, month, day).strftime("%Y-%m-%d")
    except ValueError:
        return None


# ── Label scanning ────────────────────────────────────────────────────────────

def number_after_label(
    text: str,
    label_pattern: str,
    stop_words: Iterable[str],
) -> Optional[float]:
    """
    Find the FIRST number in `text` after `label_pattern`, but only within the
    chunk that ends just before the next occurrence of any word in `stop_words`.
    This is what fixes the "Total EX VAT" bleed-through bug — a "Base 21% VAT:"
    match stops looking before it reaches "VAT 9%" or "Total".
    """
    m = re.search(label_pattern, text, re.IGNORECASE)
    if not m:
        return None
    rest = text[m.end():]
    # Find the earliest position where any stop word starts (case-insensitive,
    # word-bounded so "BTW" inside "FACTUURBEDRAG" isn't a stop).
    cutoff = len(rest)
    for word in stop_words:
        sm = re.search(r"\b" + re.escape(word) + r"\b", rest, re.IGNORECASE)
        if sm and sm.start() < cutoff:
            cutoff = sm.start()
    chunk = rest[:cutoff]
    num_match = re.search(r"[-+]?\d[\d.,]*", chunk)
    if num_match:
        return parse_number(num_match.group(0))
    return None


# ── Invoice number ────────────────────────────────────────────────────────────

INVOICE_NUMBER_LABELS = (
    r"Invoice\s+Number\s*[:.]?",
    r"Invoice\s+No\.?\s*[:.]?",
    r"Inv\.?\s*#\s*[:.]?",
    r"Inv\.?\s*No\.?\s*[:.]?",
    r"Factuurnummer\s*[:.]?",
    r"Factuurnr\.?\s*[:.]?",
    r"Factuur\s*nr\.?\s*[:.]?",
    r"Factnr\.?\s*[:.]?",
    r"Reference\s*[:.]?",
    r"Ref\.?\s*[:.]?",
    r"\bNummer\s*[:.]?",
    r"\bNr\.?\s*[:.]",  # word-boundary on Nr stops it matching inside "Factuurnr"
)


def extract_invoice_number(text: str) -> Optional[str]:
    """
    Pick the first token AFTER a recognised label that contains at least one
    digit. Skipping pure-alphabetic words like "Date" or "Issued" fixes the
    "picks up wrong word" bug.
    """
    for label in INVOICE_NUMBER_LABELS:
        m = re.search(label, text, re.IGNORECASE)
        if not m:
            continue
        rest = text[m.end(): m.end() + 200]
        for tok_match in re.finditer(r"[A-Za-z0-9][A-Za-z0-9/\-_]{0,40}", rest):
            tok = tok_match.group(0)
            if re.search(r"\d", tok):
                return tok.rstrip(".,;:")
    return None


# ── Date ──────────────────────────────────────────────────────────────────────

DATE_LABELS = (
    r"Date\s+Issued\s*[:.]?",
    r"Issue\s+Date\s*[:.]?",
    r"Invoice\s+Date\s*[:.]?",
    r"Factuurdatum\s*[:.]?",
    r"Datum\s*[:.]?",
    r"Date\s*[:.]?",
)

DATE_PATTERNS = (
    r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b",       # ISO 2026-04-04
    r"\b(\d{1,2})[-./](\d{1,2})[-./](\d{4})\b",     # DD-MM-YYYY etc.
)


def _try_date_in(text_window: str) -> Optional[str]:
    for pat in DATE_PATTERNS:
        dm = re.search(pat, text_window)
        if dm:
            a, b, c = dm.groups()
            if len(a) == 4:
                return normalise_date(int(a), int(b), int(c))
            return normalise_date(int(c), int(b), int(a))
    return None


def extract_date(text: str) -> Optional[str]:
    for label in DATE_LABELS:
        m = re.search(label, text, re.IGNORECASE)
        if m:
            d = _try_date_in(text[m.end(): m.end() + 80])
            if d:
                return d
    return _try_date_in(text)


# ── Total amount ──────────────────────────────────────────────────────────────

TOTAL_LABELS = (
    r"Amount\s+In\.?\s*VAT",
    r"Amount\s+Incl(?:\.|usive)?\s*VAT",
    r"Total\s+EUR\s+Incl(?:\.|usive)?\s*VAT",
    r"Total\s+Incl(?:\.|usive)?\s*VAT",
    r"Totaal\s+incl\.?\s*BTW",
    r"FACTUURBEDRAG",
    r"Factuurbedrag",
    r"PRIJS\s+INCL",
    r"Grand\s+Total",
    r"Total\s+Amount\b",
    r"Totaalbedrag",
    # Deliberately omit a generic "Total"/"Totaal" so phrases like "Total EX VAT"
    # / "Totaal excl. BTW" don't false-match the grand total.
)


def extract_total_amount(text: str) -> float:
    for label in TOTAL_LABELS:
        m = re.search(label, text, re.IGNORECASE)
        if m:
            tail = text[m.end(): m.end() + 80]
            num_match = re.search(r"[-+]?\d[\d.,]*", tail)
            if num_match:
                return trunc_2(parse_number(num_match.group(0)))
    return 0.0


# ── Currency ─────────────────────────────────────────────────────────────────

def extract_currency(text: str) -> str:
    upper = text.upper()
    if "€" in text or "EUR" in upper:
        return "EUR"
    if "£" in text or "GBP" in upper:
        return "GBP"
    if "$" in text or "USD" in upper:
        return "USD"
    return "EUR"


# ── VAT breakdown — four patterns, tried in priority order ────────────────────

def _empty_breakdown() -> dict:
    return {"net_21": 0.0, "vat_21": 0.0, "net_9": 0.0, "vat_9": 0.0, "net_0": 0.0, "emballage": 0.0}


# Pattern 2 — Mix Food triplets:  "0,00  10,80  0,0000"  ↦ rate=0 base=10.80 vat=0
#                                "9,00  247,81 22,3029" ↦ rate=9 base=247.81 vat=22.30
#                                "21,00 73,55  15,4455" ↦ rate=21 base=73.55 vat=15.44
MIX_FOOD_TRIPLET = re.compile(
    r"(?:(?<=\s)|^)"            # line start or whitespace
    r"(\d{1,2})[,.]00?"         # rate column ends in ",00" / ",0" / ".00"
    r"\s+([\d][\d.,]*)"          # base
    r"\s+([\d][\d.,]*)",         # vat
)


def try_mixfood(text: str, bd: dict) -> bool:
    hit = False
    for m in MIX_FOOD_TRIPLET.finditer(text):
        rate = int(m.group(1))
        if rate not in (0, 9, 21):
            continue
        base = parse_number(m.group(2))
        vat = parse_number(m.group(3))
        if rate == 21:
            bd["net_21"] = trunc_2(base)
            bd["vat_21"] = trunc_2(vat)
            hit = True
        elif rate == 9:
            bd["net_9"] = trunc_2(base)
            bd["vat_9"] = trunc_2(vat)
            hit = True
        elif rate == 0:
            if base > 0:
                bd["emballage"] = trunc_2(base)
                hit = True
    return hit


# Pattern 3 — Alaseel: "Base 9% VAT: € 1,045.33 / VAT 9%: € 94.11" etc.
# Stop words prevent "Total EX VAT: 1,091.67" bleeding into the wrong field.
_ALASEEL_STOPS = ("Base", "VAT", "Total", "Amount", "PRIJS")


def try_alaseel(text: str, bd: dict) -> bool:
    hit = False
    pairs = (
        ("net_9",  r"Base\s+9\s*%\s*VAT[:.]?"),
        ("net_21", r"Base\s+21\s*%\s*VAT[:.]?"),
        ("vat_9",  r"VAT\s+9\s*%[:.]?"),
        ("vat_21", r"VAT\s+21\s*%[:.]?"),
    )
    for field, label in pairs:
        n = number_after_label(text, label, _ALASEEL_STOPS)
        if n is not None:
            bd[field] = trunc_2(n)
            hit = True
    return hit


# Pattern 1 — Jan de Geus: "Artikel hoog ... / BTW hoog ... / Artikel laag ... / BTW laag ..."
_JDG_STOPS = ("Artikel", "BTW")


def try_jan_de_geus(text: str, bd: dict) -> bool:
    hit = False
    pairs = (
        ("net_9",  r"Artikel\s+laag\b"),
        ("vat_9",  r"BTW\s+laag\b"),
        ("net_21", r"Artikel\s+hoog\b"),
        ("vat_21", r"BTW\s+hoog\b"),
    )
    for field, label in pairs:
        n = number_after_label(text, label, _JDG_STOPS)
        if n is not None:
            bd[field] = trunc_2(n)
            hit = True
    return hit


# Pattern 4 — single rate + total (tunnel/toll receipts):
#   "BTW (21,00%): 1,08"  +  "PRIJS INCL: 6,20"   ↦  net_21 = 6.20 − 1.08
TUNNEL_BTW_RATE = re.compile(
    r"BTW\s*\(\s*(\d{1,2})[,.]?\d*\s*%\s*\)\s*[:.]?\s*([\d.,]+)",
    re.IGNORECASE,
)


def try_tunnel(text: str, total_amount: float, bd: dict) -> bool:
    m = TUNNEL_BTW_RATE.search(text)
    if not m:
        return False
    rate = int(m.group(1))
    if rate not in (0, 9, 21):
        return False
    vat = trunc_2(parse_number(m.group(2)))
    if total_amount <= 0:
        # Fall back to a local "PRIJS INCL" lookup if the generic extractor missed it
        tm = re.search(r"PRIJS\s+INCL[:.]?\s*([\d.,]+)", text, re.IGNORECASE)
        if tm:
            total_amount = parse_number(tm.group(1))
    if vat <= 0 or total_amount <= 0:
        return False
    net = trunc_2(total_amount - vat)
    if rate == 21:
        bd["net_21"], bd["vat_21"] = net, vat
    elif rate == 9:
        bd["net_9"], bd["vat_9"] = net, vat
    else:
        bd["net_0"] = trunc_2(total_amount)
    return True


def extract_vat_breakdown(text: str, total_amount: float) -> dict:
    bd = _empty_breakdown()
    # Order matters — most-specific first.
    if try_mixfood(text, bd):
        return bd
    if try_alaseel(text, bd):
        return bd
    if try_jan_de_geus(text, bd):
        return bd
    if try_tunnel(text, total_amount, bd):
        return bd
    return bd


# ── VAT rate ──────────────────────────────────────────────────────────────────

ALLOWED_VAT_RATES = (0, 9, 21)


def derive_vat_rate(bd: dict, text: str) -> int:
    """
    Pick the dominant rate from the breakdown's VAT column. Falls back to a
    simple scan for an explicit "NN%" if the breakdown is empty. Anything not
    in {0, 9, 21} is normalised to 0.
    """
    if bd["vat_9"] > 0 and bd["vat_9"] >= bd["vat_21"]:
        return 9
    if bd["vat_21"] > 0:
        return 21
    if bd["net_9"] > 0 and bd["net_9"] >= bd["net_21"]:
        return 9
    if bd["net_21"] > 0:
        return 21
    if bd["net_0"] > 0 or bd["emballage"] > 0:
        return 0
    m = re.search(r"(\d{1,2})\s*[,.]?\d*\s*%", text)
    if m:
        rate = int(m.group(1))
        return rate if rate in ALLOWED_VAT_RATES else 0
    return 0


# ── Sanity check ──────────────────────────────────────────────────────────────

def _check_breakdown_sum(bd: dict, total_amount: float, invoice_number: Optional[str]) -> None:
    if total_amount <= 0:
        return
    s = sum(float(v) for v in bd.values())
    if abs(s - total_amount) > 1.0:
        logger.warning(
            "[parser] vat_breakdown sum %.2f differs from total_amount %.2f for invoice %s — likely a missed row",
            s, total_amount, invoice_number or "<unknown>",
        )


# ── Public entry ──────────────────────────────────────────────────────────────

def parse_invoice(text: str) -> dict:
    text = text or ""
    invoice_number = extract_invoice_number(text)
    date = extract_date(text)
    total_amount = extract_total_amount(text)
    currency = extract_currency(text)
    bd = extract_vat_breakdown(text, total_amount)
    vat_rate = derive_vat_rate(bd, text)
    if vat_rate not in ALLOWED_VAT_RATES:
        vat_rate = 0

    _check_breakdown_sum(bd, total_amount, invoice_number)

    return {
        "supplier_name": None,
        "client_name": None,
        "invoice_number": invoice_number,
        "date": date,
        "total_amount": trunc_2(total_amount),
        "currency": currency,
        "vat_rate": vat_rate,
        "vat_breakdown": bd,
        "transaction_type": "inkoop",
    }
