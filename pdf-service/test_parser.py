"""
test_parser.py — runs the three spec test cases through parse_invoice and
prints PASS/FAIL per assertion. Run with:  python3 pdf-service/test_parser.py
"""
from __future__ import annotations

import json
import sys

from invoice_parser import parse_invoice


CASES = [
    # (label, input text, expected subset)
    (
        "Jan de Geus",
        "Factuurnr. : 595352 Datum : 04-04-2026 FACTUURBEDRAG 837,94 "
        "Artikel laag 768,75 BTW laag 69,19 Artikel hoog 0,00 BTW hoog 0,00",
        {
            "invoice_number": "595352",
            "date": "2026-04-04",
            "total_amount": 837.94,
            "currency": "EUR",
            "vat_rate": 9,
            "vat_breakdown": {
                "net_21": 0.0, "vat_21": 0.0,
                "net_9": 768.75, "vat_9": 69.19,
                "net_0": 0.0, "emballage": 0.0,
            },
        },
    ),
    (
        "Alaseel",
        "Invoice Number: 2600719 Date Issued: 27.02.2026 Amount In.VAT: 1195.51 "
        "Base 9% VAT: 1045.33 VAT 9%: 94.11 "
        "Base 21% VAT: 46.34 VAT 21%: 9.73",
        {
            "invoice_number": "2600719",
            "date": "2026-02-27",
            "total_amount": 1195.51,
            "currency": "EUR",
            "vat_rate": 9,
            "vat_breakdown": {
                "net_21": 46.34, "vat_21": 9.73,
                "net_9": 1045.33, "vat_9": 94.11,
                "net_0": 0.0, "emballage": 0.0,
            },
        },
    ),
    (
        "Tunnel",
        "Nr: OZ208 Datum: 04/06/2026 BTW (21,00%): 1,08 PRIJS INCL: 6,20",
        {
            "invoice_number": "OZ208",
            "date": "2026-06-04",
            "total_amount": 6.20,
            "currency": "EUR",
            "vat_rate": 21,
            "vat_breakdown": {
                "net_21": 5.12, "vat_21": 1.08,
                "net_9": 0.0, "vat_9": 0.0,
                "net_0": 0.0, "emballage": 0.0,
            },
        },
    ),
]


def assert_subset(label: str, actual: dict, expected: dict) -> int:
    """Recursive subset compare with ε for floats. Returns number of failures."""
    failures = 0
    for key, exp_v in expected.items():
        got = actual.get(key)
        if isinstance(exp_v, dict):
            failures += assert_subset(f"{label}.{key}", got or {}, exp_v)
        elif isinstance(exp_v, float):
            if got is None or abs(float(got) - exp_v) > 0.01:
                print(f"  ✗ {label}.{key}: expected {exp_v}, got {got!r}")
                failures += 1
            else:
                print(f"  ✓ {label}.{key} = {got}")
        else:
            if got != exp_v:
                print(f"  ✗ {label}.{key}: expected {exp_v!r}, got {got!r}")
                failures += 1
            else:
                print(f"  ✓ {label}.{key} = {got!r}")
    return failures


def main() -> int:
    total_failures = 0
    for label, text, expected in CASES:
        print(f"\n── {label} ────────────────────────────────────────────")
        actual = parse_invoice(text)
        print(f"  raw: {json.dumps(actual, ensure_ascii=False)}")
        total_failures += assert_subset(label, actual, expected)

    print()
    if total_failures == 0:
        print(f"ALL {len(CASES)} CASES PASS")
        return 0
    print(f"FAILED — {total_failures} assertion(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
