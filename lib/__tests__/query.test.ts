import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { filtersFromRequest, applyCommonFilters } from "@/lib/query";

function makeReq(url: string) {
  return new NextRequest(url);
}

describe("filtersFromRequest", () => {
  it("returns empty/default filters when no query params present", () => {
    const f = filtersFromRequest(makeReq("http://localhost/api/x"));
    expect(f).toEqual({
      phone:     undefined,
      status:    undefined,
      from:      undefined,
      to:        undefined,
      order:     "created_at_desc",
      client:    undefined,
      invoice:   undefined,
      direction: undefined,
    });
  });

  it("normalises phone (strips spaces, dashes, parens)", () => {
    const f = filtersFromRequest(
      makeReq("http://localhost/api/x?phone=%2B31+6+12-34-56-78")
    );
    expect(f.phone).toBe("+31612345678");
  });

  it("reads all supported params", () => {
    const f = filtersFromRequest(
      makeReq(
        "http://localhost/api/x?status=extracted&from=2026-05-01&to=2026-05-31" +
        "&client=Nema&invoice=INV-1&direction=verkoop&order=created_at_asc"
      )
    );
    expect(f.status).toBe("extracted");
    expect(f.from).toBe("2026-05-01");
    expect(f.to).toBe("2026-05-31");
    expect(f.client).toBe("Nema");
    expect(f.invoice).toBe("INV-1");
    expect(f.direction).toBe("verkoop");
    expect(f.order).toBe("created_at_asc");
  });
});

/**
 * applyCommonFilters operates on a Supabase query builder. We feed it a
 * chainable spy and assert that the right methods are called with the right
 * arguments.
 */
function makeQuerySpy() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const handler: ProxyHandler<object> = {
    get(_t, method: string) {
      return (...args: unknown[]) => {
        calls.push({ method, args });
        return proxy;
      };
    },
  };
  const proxy: unknown = new Proxy({}, handler);
  return { proxy, calls };
}

describe("applyCommonFilters", () => {
  it("applies phone ilike when phone is present", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(proxy, {
      phone: "+316",
      order: "created_at_desc",
      status: undefined, from: undefined, to: undefined,
      client: undefined, invoice: undefined, direction: undefined,
    });
    expect(calls.find((c) => c.method === "ilike")).toEqual({
      method: "ilike",
      args: ["phone_number", "%+316%"],
    });
  });

  it("applies status eq filter", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(proxy, {
      status: "extracted",
      order: "created_at_desc",
      phone: undefined, from: undefined, to: undefined,
      client: undefined, invoice: undefined, direction: undefined,
    });
    expect(calls).toContainEqual({ method: "eq", args: ["status", "extracted"] });
  });

  it("date column 'date' (date type) does NOT extend 'to' to end-of-day", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(
      proxy,
      {
        from: "2026-05-01", to: "2026-05-31",
        order: "created_at_desc",
        phone: undefined, status: undefined,
        client: undefined, invoice: undefined, direction: undefined,
      },
      "date"
    );
    const lte = calls.find((c) => c.method === "lte");
    expect(lte?.args).toEqual(["date", "2026-05-31"]);
  });

  it("timestamp date column extends a plain YYYY-MM-DD 'to' value to end-of-day", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(
      proxy,
      {
        to: "2026-05-31",
        from: undefined, order: "created_at_desc",
        phone: undefined, status: undefined,
        client: undefined, invoice: undefined, direction: undefined,
      },
      "created_at"
    );
    const lte = calls.find((c) => c.method === "lte");
    expect(lte?.args).toEqual(["created_at", "2026-05-31T23:59:59.999Z"]);
  });

  it("ilike's client_name and invoice_number when those filters are present", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(proxy, {
      client: "Nema", invoice: "INV-1",
      order: "created_at_desc",
      phone: undefined, status: undefined, from: undefined, to: undefined,
      direction: undefined,
    });
    expect(calls).toContainEqual({ method: "ilike", args: ["client_name", "%Nema%"] });
    expect(calls).toContainEqual({ method: "ilike", args: ["invoice_number", "%INV-1%"] });
  });

  it("applies direction eq filter", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(proxy, {
      direction: "inkoop",
      order: "created_at_desc",
      phone: undefined, status: undefined, from: undefined, to: undefined,
      client: undefined, invoice: undefined,
    });
    expect(calls).toContainEqual({ method: "eq", args: ["invoice_direction", "inkoop"] });
  });

  it("calls nothing when no filters are set", () => {
    const { proxy, calls } = makeQuerySpy();
    applyCommonFilters(proxy, {
      order: "created_at_desc",
      phone: undefined, status: undefined, from: undefined, to: undefined,
      client: undefined, invoice: undefined, direction: undefined,
    });
    expect(calls).toEqual([]);
  });
});

// Silence "unused import" tree-shaking warnings if any
vi.fn();
