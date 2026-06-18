import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { sampleApiInvoiceRow } from "@/__tests__/fixtures/invoices";

const { mockSupabase, uploadInvoiceExcelExport, uploadZipExport } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return {
    mockSupabase: makeSupabaseAdmin(vi),
    uploadInvoiceExcelExport: vi.fn(),
    uploadZipExport: vi.fn(),
  };
});

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));
vi.mock("@/lib/export-builders", () => ({
  uploadInvoiceExcelExport,
  uploadZipExport,
}));

import { POST } from "@/app/api/export/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
  uploadInvoiceExcelExport.mockResolvedValue({
    file_url: "s3://exports/x.xlsx",
    download_url: "https://signed/x.xlsx",
    file_count: 1,
  });
  uploadZipExport.mockResolvedValue({
    file_url: "s3://exports/x.zip",
    download_url: "https://signed/x.zip",
    file_count: 1,
  });
});

function jsonReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/export", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/export — Excel", () => {
  it("inlines an Excel export and returns the signed download URL", async () => {
    const exportJobs = mockSupabase._table("export_jobs");
    exportJobs._setResult({
      data: { id: "job-1", status: "processing", type: "excel", created_at: "2026-05-19T00:00:00Z" },
      error: null,
    });

    const invoices = mockSupabase._table("invoices");
    invoices._setResult({ data: [sampleApiInvoiceRow], error: null });

    const res = await POST(jsonReq({ type: "excel", async_job: false, direction: "inkoop" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.download_url).toBe("https://signed/x.xlsx");
    expect(body.status).toBe("done");
    expect(uploadInvoiceExcelExport).toHaveBeenCalledTimes(1);

    // Inkoop filter must reach the invoices query
    const eqCalls = invoices._calls.filter((c: { method: string; args: unknown[] }) =>c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["invoice_direction", "inkoop"] });
  });

  it("tracks export inclusion via increment_invoice_exports for the included ids", async () => {
    const exportJobs = mockSupabase._table("export_jobs");
    exportJobs._setResult({
      data: { id: "job-t", status: "processing", type: "excel", created_at: "x" },
      error: null,
    });
    const invoices = mockSupabase._table("invoices");
    invoices._setResult({ data: [sampleApiInvoiceRow], error: null });

    await POST(jsonReq({ type: "excel", async_job: false }));

    expect(mockSupabase.rpc).toHaveBeenCalledWith("increment_invoice_exports", { p_ids: [sampleApiInvoiceRow.id] });
  });

  it("does not track when a ZIP export runs (invoices untouched)", async () => {
    const exportJobs = mockSupabase._table("export_jobs");
    exportJobs._setResult({ data: { id: "job-zt", status: "processing", type: "zip", created_at: "x" }, error: null });
    mockSupabase._table("files")._setResult({ data: [{ file_key: "files/a.pdf" }], error: null });

    await POST(jsonReq({ type: "zip", async_job: false }));

    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it("filters by ids[] (selection-based export) instead of common filters", async () => {
    const exportJobs = mockSupabase._table("export_jobs");
    exportJobs._setResult({
      data: { id: "job-2", status: "processing", type: "excel", created_at: "2026-05-19T00:00:00Z" },
      error: null,
    });
    const invoices = mockSupabase._table("invoices");
    invoices._setResult({ data: [sampleApiInvoiceRow], error: null });

    await POST(jsonReq({
      type: "excel",
      async_job: false,
      ids: ["11111111-1111-1111-1111-111111111111"],
    }));

    const inCalls = invoices._calls.filter((c: { method: string; args: unknown[] }) =>c.method === "in");
    expect(inCalls).toContainEqual({
      method: "in",
      args: ["id", ["11111111-1111-1111-1111-111111111111"]],
    });
  });

  it("returns a 202 with a poll URL when async_job=true", async () => {
    const exportJobs = mockSupabase._table("export_jobs");
    exportJobs._setResult({
      data: { id: "job-3", status: "processing", type: "excel", created_at: "x" },
      error: null,
    });

    const res = await POST(jsonReq({ type: "excel", async_job: true }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.poll_url).toBe("/api/export?jobId=job-3");
    expect(uploadInvoiceExcelExport).not.toHaveBeenCalled();
  });
});

describe("POST /api/export — ZIP", () => {
  it("collects file_keys and calls uploadZipExport with s3:// URIs", async () => {
    const exportJobs = mockSupabase._table("export_jobs");
    exportJobs._setResult({
      data: { id: "job-z", status: "processing", type: "zip", created_at: "x" },
      error: null,
    });
    const files = mockSupabase._table("files");
    files._setResult({
      data: [{ file_key: "files/2026/05/a.pdf" }, { file_key: "files/2026/05/b.pdf" }],
      error: null,
    });

    const res = await POST(jsonReq({ type: "zip", async_job: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.download_url).toBe("https://signed/x.zip");

    expect(uploadZipExport).toHaveBeenCalledTimes(1);
    const args = uploadZipExport.mock.calls[0][0];
    expect(args.fileUrls).toEqual([
      "s3://test-bucket/files/2026/05/a.pdf",
      "s3://test-bucket/files/2026/05/b.pdf",
    ]);
  });
});

describe("POST /api/export — validation", () => {
  it("returns 400 for unknown export type", async () => {
    const res = await POST(jsonReq({ type: "csv" }));
    expect(res.status).toBe(400);
  });
});
