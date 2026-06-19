// @vitest-environment node
// Multipart upload + undici Request/File/FormData must share one realm — jsdom's
// File doesn't round-trip through req.formData(), so this suite runs in node.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { POST } from "@/app/api/snelstart-import/route";

const CID = "11111111-1111-1111-1111-111111111111";

// Build a real .xlsx buffer shaped like a Snelstart "Alle-facturen" export.
async function buildXlsx(opts: { breakHeader?: boolean } = {}): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Alle-facturen");
  const header = ["Factuurnummer", "Datum", "Status", "Client", "Klantnummer", "Bedrag exclusief BTW", "Bedrag inclusief BTW"];
  if (opts.breakHeader) header[3] = "WrongColumn";
  header.forEach((h, i) => { ws.getRow(6).getCell(i + 1).value = h; });
  const data: Array<Array<string | number | null>> = [
    ["concept", "2026-06-19", "Concept", "Sisou", null, 0, 0],
    [2357, "2026-06-01", "Open", "Nema Food", null, 100, 121],
    [2358, "2026-06-02", "Betaald", "Unknown Co", null, 100, 109],
  ];
  data.forEach((r, idx) => {
    const row = ws.getRow(7 + idx);
    r.forEach((v, i) => { row.getCell(i + 1).value = v as ExcelJS.CellValue; });
  });
  return (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

function postReq(form: FormData) {
  return new NextRequest("http://localhost/api/snelstart-import", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" }, // same-origin → passes requireInternalApiKey
    body: form,
  });
}

function seedCustomers(rows: Array<{ id: string; client_id: string; name: string; relatie_code: string | null }>) {
  mockSupabase._table("customers")._setResult({ data: rows, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

describe("POST /api/snelstart-import", () => {
  it("converts a valid upload → 200 with summary counts + a base64 workbook", async () => {
    seedCustomers([{ id: "c1", client_id: CID, name: "Nema Food B.V.", relatie_code: "10" }]);

    const fd = new FormData();
    fd.append("file", new File([await buildXlsx()], "Alle-facturen.xlsx"));
    fd.append("client_id", CID);

    const res = await POST(postReq(fd));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary.imported).toBe(2);
    expect(body.summary.skippedConcept).toBe(1);
    expect(body.summary.matched).toBe(1);                 // Nema Food
    expect(body.summary.blank).toBe(1);                   // Unknown Co
    expect(body.summary.unmatchedNames).toEqual([{ name: "Unknown Co", count: 1 }]);
    expect(body.summary.rateCounts).toEqual({ 0: 0, 9: 1, 21: 1 });
    expect(body.filename).toMatch(/^Boekingen_verkoop_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(typeof body.file_base64).toBe("string");
    expect(body.file_base64.length).toBeGreaterThan(100);

    // customers were queried scoped to the chosen client (read-only).
    const eqCalls = mockSupabase._table("customers")._calls.filter((c: { method: string; args: unknown[] }) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["client_id", CID] });
  });

  it("rejects a wrong-shape spreadsheet with 400 and a clear message", async () => {
    seedCustomers([]);
    const fd = new FormData();
    fd.append("file", new File([await buildXlsx({ breakHeader: true })], "Alle-facturen.xlsx"));
    fd.append("client_id", CID);

    const res = await POST(postReq(fd));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Snelstart|column "Client"/i);
  });

  it("rejects a non-.xlsx file with 400", async () => {
    const fd = new FormData();
    fd.append("file", new File(["not a spreadsheet"], "notes.txt"));
    fd.append("client_id", CID);

    const res = await POST(postReq(fd));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.xlsx/i);
  });

  it("rejects a missing/invalid client_id with 400", async () => {
    const fd = new FormData();
    fd.append("file", new File([await buildXlsx()], "Alle-facturen.xlsx"));
    // no client_id
    const res = await POST(postReq(fd));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/client/i);
  });
});
