import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { POST } from "@/app/api/clients/[id]/customers/bulk/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

const SO = { "sec-fetch-site": "same-origin" };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function xlsxFile(rows: unknown[][]): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], "customers.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// Build a request whose formData() yields our File — avoids depending on the
// runtime's multipart parser in the test environment.
async function importReq(rows: unknown[][]): Promise<NextRequest> {
  const form = new FormData();
  form.append("file", await xlsxFile(rows));
  const req = new NextRequest("http://localhost/api/clients/c1/customers/bulk", { method: "POST", headers: SO });
  vi.spyOn(req, "formData").mockResolvedValue(form);
  return req;
}

describe("customers Excel import", () => {
  it("imports customers, mapping Dutch headers (Naam, Klantnummer → relatie_code)", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1" }, error: null });
    // The single customers chain serves both the existing-name query and the
    // insert; rows have no `name` so nothing is treated as a duplicate.
    mockSupabase._table("customers")._setResult({ data: [{ id: "n1" }, { id: "n2" }], error: null });

    const res = await POST(
      await importReq([
        ["Naam", "Klantnummer", "KvK"],
        ["Klant A", "20001", "11112222"],
        ["Klant B", "20002", "33334444"],
      ]),
      params("c1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.total_rows).toBe(2);
    expect(body.detected_columns).toEqual(expect.arrayContaining(["name", "relatie_code", "kvk"]));

    // The Klantnummer column landed in relatie_code on the inserted rows.
    const insert = mockSupabase._table("customers")._calls.find((c: { method: string; args: unknown[] }) => c.method === "insert")!;
    const inserted = insert.args[0] as Array<Record<string, unknown>>;
    expect(inserted[0].relatie_code).toBe("20001");
    expect(inserted[0].client_id).toBe("c1");
  });

  it("rejects a sheet with no Name/Naam column (400)", async () => {
    mockSupabase._table("clients")._setResult({ data: { id: "c1" }, error: null });
    const res = await POST(
      await importReq([
        ["Foo", "Bar"],
        ["x", "y"],
      ]),
      params("c1"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/header/i);
  });

  it("returns 404 when the client does not exist", async () => {
    mockSupabase._table("clients")._setResult({ data: null, error: null });
    const res = await POST(
      await importReq([["Naam"], ["Klant A"]]),
      params("c1"),
    );
    expect(res.status).toBe(404);
  });
});
