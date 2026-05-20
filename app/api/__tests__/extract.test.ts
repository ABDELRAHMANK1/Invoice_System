import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));

vi.mock("@/lib/ai-extraction", () => ({
  extractInvoicesFromUrls: extractMock,
}));

import { POST } from "@/app/api/extract/route";

beforeEach(() => vi.clearAllMocks());

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/extract", () => {
  it("returns extracted invoice rows on success", async () => {
    extractMock.mockResolvedValue([
      {
        client_name: "Nema Food", invoice_number: "INV-1",
        date: "2026-05-10", total_amount: 121, currency: "EUR",
        vat_rate: 21, transaction_type: "inkoop", confidence: 0.96,
      },
    ]);

    const res = await POST(jsonReq({ file_urls: ["s3://bucket/key.pdf"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].invoice_number).toBe("INV-1");
    expect(extractMock).toHaveBeenCalledWith(["s3://bucket/key.pdf"]);
  });

  it("rejects requests with no file_urls (400)", async () => {
    const res = await POST(jsonReq({ file_urls: [] }));
    expect(res.status).toBe(400);
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("rejects batches larger than 10 files (400)", async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `s3://bucket/${i}.pdf`);
    const res = await POST(jsonReq({ file_urls: urls }));
    expect(res.status).toBe(400);
  });

  it("returns 502 when the AI client throws", async () => {
    extractMock.mockRejectedValue(new Error("rate limited"));
    const res = await POST(jsonReq({ file_urls: ["s3://bucket/k.pdf"] }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("rate limited");
  });
});
