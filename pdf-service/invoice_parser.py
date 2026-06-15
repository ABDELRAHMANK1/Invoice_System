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
    r"Totaal\s+incl\.?\s*BTW",        # also matches "TOTAAL Incl.BTW: 765,13 EUR"
    r"Totaal\s+te\s+betalen",         # MOCCA: "totaal te betalen EU 196,52"
    r"Totaal\s+in\s+euro",            # SAFE: "Totaal in euro: € 176,09"
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


# Pattern 3a — General "Base N% VAT" handler covering BOTH label/amount layouts.
#
#   Normal   layout:  "Base 21% VAT: € 46.34"          (label → amount)
#   Reversed layout:  "€ 46.34Base 21% VAT:"           (amount → label)
#
# Reversed invoices glue the net amount directly in front of the "Base N% VAT:"
# label, and scatter the VAT amounts on later lines that no longer sit right
# after their "VAT N%:" label (e.g. "VAT 21%:\n€ 1,091.67\n€ 94.11 € 9.73").
# Grabbing the number "after VAT N%:" therefore fails. Instead we recover each
# net deterministically (the number adjacent to its Base label) and then pick
# the VAT amount by an arithmetic cross-check: among every number in the text,
# the one closest to net × rate is the VAT for that rate.
_BASE_VAT_LABELS = (
    ("net_21", "vat_21", r"Base\s+21\s*%\s*VAT[:.]?", 21),
    ("net_9",  "vat_9",  r"Base\s+9\s*%\s*VAT[:.]?",  9),
)


def _all_numbers(text: str) -> list[float]:
    return [parse_number(m.group(0)) for m in re.finditer(r"[-+]?\d[\d.,]*", text)]


def _closest_number(candidates: Iterable[float], target: float) -> Optional[float]:
    """The candidate nearest `target`, accepted only if within a small tolerance."""
    best, best_diff = None, None
    for c in candidates:
        d = abs(c - target)
        if best_diff is None or d < best_diff:
            best, best_diff = c, d
    if best is None:
        return None
    # Tolerance scales with the target so cent-level OCR drift on a four-figure
    # net (94.08 vs 94.11) is still accepted, while garbage is rejected.
    if best_diff <= max(0.5, target * 0.05):
        return best
    return None


def try_base_vat(text: str, bd: dict) -> bool:
    if not re.search(r"Base\s+\d+\s*%\s*VAT", text, re.IGNORECASE):
        return False
    # Reversed layout signalled by a digit glued (no space) right before "Base".
    reversed_layout = bool(re.search(r"\d[€$£]?Base\s*\d+\s*%", text, re.IGNORECASE))
    all_nums = _all_numbers(text)
    hit = False
    for net_field, vat_field, label, rate in _BASE_VAT_LABELS:
        m = re.search(label, text, re.IGNORECASE)
        if not m:
            continue
        if reversed_layout:
            # Net is the trailing number immediately before the label.
            bm = re.search(r"([-+]?\d[\d.,]*)\s*$", text[: m.start()])
            net = parse_number(bm.group(1)) if bm else None
        else:
            # Net is the first number after the label.
            am = re.search(r"[-+]?\d[\d.,]*", text[m.end(): m.end() + 40])
            net = parse_number(am.group(0)) if am else None
        if net is None or net <= 0:
            continue
        bd[net_field] = trunc_2(net)
        hit = True
        vat = _closest_number(all_nums, net * rate / 100.0)
        if vat is not None:
            bd[vat_field] = trunc_2(vat)
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


# Pattern 5 — MOCCA: invoice gives only the rolled-up "ex BTW" net and total
# BTW, no per-rate breakdown:
#   "totaal ex btw: 180,30" / "totaal btw: 16,22" / "totaal te betalen: 196,52"
# Infer the rate from the ratio and file the pair under net_9/vat_9 or
# net_21/vat_21 accordingly.
_MOCCA_STOPS = ("totaal", "te", "btw")


def try_mocca(text: str, bd: dict) -> bool:
    net = number_after_label(text, r"totaal\s+ex\s+btw[:.]?", _MOCCA_STOPS)
    vat = number_after_label(text, r"totaal\s+btw[:.]?", _MOCCA_STOPS)
    if net is None or vat is None or net <= 0 or vat <= 0:
        return False
    rate = round(vat / net * 100)
    if abs(rate - 9) <= 1:
        bd["net_9"], bd["vat_9"] = trunc_2(net), trunc_2(vat)
    elif abs(rate - 21) <= 2:
        bd["net_21"], bd["vat_21"] = trunc_2(net), trunc_2(vat)
    else:
        return False
    return True


# Pattern 6 — Slagerij Overschie line items: each row carries its own rate,
#   "HALVE KIP | 15,96 | 9%"  /  "RUNDERLAP | 8,40 | 21%"
# Sum the amounts per rate. The trailing "N%" disambiguates which net bucket
# each amount belongs to.
LINE_ITEM_RATE = re.compile(r"([\d][\d.,]*)\s*\|\s*(\d{1,2})\s*%")


def try_slagerij(text: str, bd: dict) -> bool:
    hit = False
    for m in LINE_ITEM_RATE.finditer(text):
        amt = parse_number(m.group(1))
        rate = int(m.group(2))
        if amt <= 0:
            continue
        if rate == 9:
            bd["net_9"] = trunc_2(bd["net_9"] + amt)
            hit = True
        elif rate == 21:
            bd["net_21"] = trunc_2(bd["net_21"] + amt)
            hit = True
        elif rate == 0:
            bd["net_0"] = trunc_2(bd["net_0"] + amt)
            hit = True
    return hit


# Pattern 10 — Deniz Fruit: one row per rate, each carrying its own net/vat/incl
# behind word labels:
#   "BTW 9%  Excl. BTW € 37,00  BTW € 3,33  Incl. BTW € 40,33"
# net = the "Excl. BTW" figure, vat = the bare "BTW" figure after it.
DENIZ_ROW = re.compile(
    r"BTW\s+(\d{1,2})\s*%\s*Excl\.?\s*BTW\s*€?\s*([\d][\d.,]*)"
    r"\s*BTW\s*€?\s*([\d][\d.,]*)",
    re.IGNORECASE,
)


def try_deniz(text: str, bd: dict) -> bool:
    hit = False
    for m in DENIZ_ROW.finditer(text):
        rate = int(m.group(1))
        net = parse_number(m.group(2))
        vat = parse_number(m.group(3))
        if rate == 9:
            bd["net_9"], bd["vat_9"] = trunc_2(net), trunc_2(vat)
            hit = True
        elif rate == 21:
            bd["net_21"], bd["vat_21"] = trunc_2(net), trunc_2(vat)
            hit = True
        elif rate == 0:
            if net > 0:
                bd["net_0"] = trunc_2(net)
                hit = True
    return hit


# Pattern 8 — SAFE: one inline row per rate, "BTW <rate>% <vat> <net>".
#   "BTW 9%  € 14,54  € 161,55"   ↦  vat_9 = 14,54, net_9 = 161,55
# The two amounts must sit on the same line (no newline in the separator) so
# the row doesn't swallow a "Totaal" figure below it (cf. Aras).
SAFE_ROW = re.compile(
    r"BTW\s+(\d{1,2})\s*%[ \t€|:.]*([\d][\d.,]*)[ \t€|:.]+([\d][\d.,]*)",
    re.IGNORECASE,
)


def try_safe(text: str, bd: dict) -> bool:
    hit = False
    for m in SAFE_ROW.finditer(text):
        rate = int(m.group(1))
        vat = parse_number(m.group(2))   # SAFE lists vat first, then net
        net = parse_number(m.group(3))
        if rate == 9:
            bd["vat_9"], bd["net_9"] = trunc_2(vat), trunc_2(net)
            hit = True
        elif rate == 21:
            bd["vat_21"], bd["net_21"] = trunc_2(vat), trunc_2(net)
            hit = True
        elif rate == 0:
            if net > 0:
                bd["net_0"] = trunc_2(net)
                hit = True
    return hit


# Pattern 7 — S&F / Sunflower: a row laid out net → rate% → vat (→ total incl).
#   "€ 24,90  9%  € 2,24  € 27,14"   ↦  net_9 = 24,90, vat_9 = 2,24
#   table form: "€ 24,90 | 9% | € 2,24 | € 27,14"
# The net is the number before the rate, the vat the number after it. The total
# (4th cell) is left to the breakdown-sum reconciliation in parse_invoice.
SUNFLOWER_ROW = re.compile(
    r"€?\s*([\d][\d.,]*)\s*\|?\s*€?\s*(\d{1,2})\s*%\s*\|?\s*€?\s*([\d][\d.,]*)"
)


def try_sunflower(text: str, bd: dict) -> bool:
    hit = False
    for m in SUNFLOWER_ROW.finditer(text):
        net = parse_number(m.group(1))
        rate = int(m.group(2))
        vat = parse_number(m.group(3))
        if net <= 0:
            continue
        if rate == 9:
            bd["net_9"], bd["vat_9"] = trunc_2(net), trunc_2(vat)
            hit = True
        elif rate == 21:
            bd["net_21"], bd["vat_21"] = trunc_2(net), trunc_2(vat)
            hit = True
        elif rate == 0:
            bd["net_0"] = trunc_2(net)
            hit = True
    return hit


# Pattern 9 — Aras Patisserie (handwritten): a sub-total line for the net and a
# single rated BTW line for the vat:
#   "Sub-totaal: 32,00"  /  "btw 9%: 2,88"  /  "Totaal: 34,88"
# Gated on the presence of a "Sub-totaal" label so it doesn't poach SAFE rows.
_ARAS_STOPS = ("btw", "totaal", "sub")
ARAS_BTW = re.compile(r"btw\s+(\d{1,2})\s*%\s*[:.]?\s*([\d][\d.,]*)", re.IGNORECASE)


def try_aras(text: str, bd: dict) -> bool:
    if not re.search(r"Sub-?totaal", text, re.IGNORECASE):
        return False
    m = ARAS_BTW.search(text)
    if not m:
        return False
    rate = int(m.group(1))
    vat = parse_number(m.group(2))
    net = number_after_label(text, r"Sub-?totaal[:.]?", _ARAS_STOPS)
    if net is None or net <= 0:
        return False
    if rate == 9:
        bd["net_9"], bd["vat_9"] = trunc_2(net), trunc_2(vat)
    elif rate == 21:
        bd["net_21"], bd["vat_21"] = trunc_2(net), trunc_2(vat)
    elif rate == 0:
        bd["net_0"] = trunc_2(net)
    else:
        return False
    return True


def extract_vat_breakdown(text: str, total_amount: float) -> dict:
    bd = _empty_breakdown()
    # Order matters — most-specific first.
    if try_mixfood(text, bd):
        return bd
    if try_base_vat(text, bd):
        return bd
    if try_alaseel(text, bd):
        return bd
    if try_jan_de_geus(text, bd):
        return bd
    if try_tunnel(text, total_amount, bd):
        return bd
    if try_deniz(text, bd):
        return bd
    if try_safe(text, bd):
        return bd
    if try_sunflower(text, bd):
        return bd
    if try_aras(text, bd):
        return bd
    if try_slagerij(text, bd):
        return bd
    if try_mocca(text, bd):
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

    # Reconcile the total with the breakdown. When no total label was found
    # (Sunflower inline, Deniz) or a label grabbed a net cell instead of the
    # grand total (Sunflower table's "Totaalbedrag"), the sum of net+vat across
    # the breakdown is the reliable figure. Only override upward — a label total
    # that already exceeds the breakdown means a row is missing, not wrong.
    breakdown_sum = trunc_2(sum(float(v) for v in bd.values()))
    if breakdown_sum > total_amount + 0.01:
        total_amount = breakdown_sum

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
