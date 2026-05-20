import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { jsonError, normalizePhone, pagination, requireInternalApiKey } from "@/lib/http";

function makeReq(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe("normalizePhone", () => {
  it("returns undefined for null/empty", () => {
    expect(normalizePhone(null)).toBeUndefined();
    expect(normalizePhone("")).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
  });

  it("strips spaces, dashes, parens and trims", () => {
    expect(normalizePhone(" +31 (6) 12-34-56-78 ")).toBe("+31612345678");
  });

  it("keeps leading + and digits only", () => {
    expect(normalizePhone("+31612345678")).toBe("+31612345678");
    expect(normalizePhone("06 12 34 56 78")).toBe("0612345678");
  });
});

describe("jsonError", () => {
  it("defaults to status 400 with { error, details }", async () => {
    const res = jsonError("bad input");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "bad input", details: undefined });
  });

  it("respects custom status and details payload", async () => {
    const res = jsonError("validation failed", 422, { field: "phone" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: "validation failed", details: { field: "phone" } });
  });
});

describe("pagination", () => {
  it("defaults to page=1, limit=20", () => {
    const r = makeReq("http://localhost/api/x");
    expect(pagination(r)).toEqual({ page: 1, limit: 20, from: 0, to: 19 });
  });

  it("reads page and limit from query string", () => {
    const r = makeReq("http://localhost/api/x?page=3&limit=10");
    expect(pagination(r)).toEqual({ page: 3, limit: 10, from: 20, to: 29 });
  });

  it("clamps limit to maxLimit", () => {
    const r = makeReq("http://localhost/api/x?limit=99999");
    expect(pagination(r, 20, 100).limit).toBe(100);
  });

  it("clamps page to at least 1", () => {
    const r = makeReq("http://localhost/api/x?page=0");
    expect(pagination(r).page).toBe(1);
  });
});

describe("requireInternalApiKey", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null (allow) when no internal key is configured", async () => {
    vi.stubEnv("API_INTERNAL_KEY", "");
    const { requireInternalApiKey: fn } = await import("@/lib/http");
    const r = makeReq("http://localhost/api/x");
    expect(fn(r)).toBeNull();
    vi.unstubAllEnvs();
  });

  it("allows same-origin browser requests without an API key", () => {
    const r = makeReq("http://localhost/api/x", { "sec-fetch-site": "same-origin" });
    expect(requireInternalApiKey(r)).toBeNull();
  });

  it("rejects requests with a wrong x-api-key as 401", async () => {
    const r = makeReq("http://localhost/api/x", { "x-api-key": "wrong" });
    const res = requireInternalApiKey(r);
    expect(res?.status).toBe(401);
  });

  it("accepts the correct x-api-key", () => {
    const r = makeReq("http://localhost/api/x", { "x-api-key": "test-internal-key" });
    expect(requireInternalApiKey(r)).toBeNull();
  });

  it("accepts an Authorization: Bearer header equivalent", () => {
    const r = makeReq("http://localhost/api/x", {
      authorization: "Bearer test-internal-key",
    });
    expect(requireInternalApiKey(r)).toBeNull();
  });
});
