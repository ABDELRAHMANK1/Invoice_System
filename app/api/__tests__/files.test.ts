import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { sampleFileRow } from "@/__tests__/fixtures/files";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

import { POST, GET } from "@/app/api/files/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
});

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/files", () => {
  it("inserts a file row and returns it with status 201", async () => {
    const t = mockSupabase._table("files");
    t._setResult({ data: sampleFileRow, error: null });

    const res = await POST(
      jsonReq("http://localhost/api/files", {
        phone_number: "+31612345678",
        file_key:     "files/2026/05/abc.pdf",
        file_type:    "pdf",
        file_name:    "abc.pdf",
        mime_type:    "application/pdf",
        invoice_direction: "verkoop",
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual(sampleFileRow);

    const insert = t._calls.find((c: { method: string; args: unknown[] }) =>c.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      phone_number: "+31612345678",
      file_key:     "files/2026/05/abc.pdf",
      file_type:    "pdf",
      invoice_direction: "verkoop",
      status: "pending",
    });
  });

  it("defaults invoice_direction to 'inkoop' when omitted", async () => {
    const t = mockSupabase._table("files");
    t._setResult({ data: sampleFileRow, error: null });

    await POST(
      jsonReq("http://localhost/api/files", {
        phone_number: "+31612345678",
        file_key:     "files/abc.pdf",
        file_type:    "pdf",
      })
    );

    const insert = t._calls.find((c: { method: string; args: unknown[] }) =>c.method === "insert");
    expect(insert?.args[0]).toMatchObject({ invoice_direction: "inkoop" });
  });

  it("rejects invalid file_type with 400", async () => {
    const res = await POST(
      jsonReq("http://localhost/api/files", {
        phone_number: "+31612345678",
        file_key:     "files/abc.txt",
        file_type:    "unsupported",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing required fields with 400", async () => {
    const res = await POST(
      jsonReq("http://localhost/api/files", { phone_number: "+31612345678" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON body with 400", async () => {
    const r = new NextRequest("http://localhost/api/files", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: "{not json",
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
  });

  it("returns 500 when supabase insert errors", async () => {
    const t = mockSupabase._table("files");
    t._setResult({ data: null, error: { message: "db down" } });

    const res = await POST(
      jsonReq("http://localhost/api/files", {
        phone_number: "+31612345678",
        file_key:     "x.pdf",
        file_type:    "pdf",
      })
    );
    expect(res.status).toBe(500);
  });
});

describe("GET /api/files", () => {
  it("returns paginated rows with total and totalPages", async () => {
    const t = mockSupabase._table("files");
    t._setResult({ data: [sampleFileRow], error: null, count: 1 });

    const res = await GET(
      new NextRequest("http://localhost/api/files?page=1&limit=50", {
        headers: { "sec-fetch-site": "same-origin" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalPages).toBe(1);
  });

  it("applies phone filter via eq", async () => {
    const t = mockSupabase._table("files");
    t._setResult({ data: [], error: null, count: 0 });
    await GET(
      new NextRequest("http://localhost/api/files?phone=%2B31612345678", {
        headers: { "sec-fetch-site": "same-origin" },
      })
    );
    const eq = t._calls.find((c: { method: string; args: unknown[] }) =>c.method === "eq" && (c.args[0] as string) === "phone_number");
    expect(eq?.args).toEqual(["phone_number", "+31612345678"]);
  });
});
