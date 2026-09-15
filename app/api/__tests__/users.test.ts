import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSupabase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeSupabaseAdmin } = require("../../../__tests__/helpers/supabase-mock.js");
  return { mockSupabase: makeSupabaseAdmin(vi) };
});

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: mockSupabase }));

// The session is resolved from cookies via next/headers, which has no meaning
// in a unit test — stub the one function the guards call.
const { getAuthProfile } = vi.hoisted(() => ({ getAuthProfile: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthProfile }));

import { GET as listUsers } from "@/app/api/users/route";
import { PATCH as patchUser } from "@/app/api/users/[id]/route";
import type { AuthProfile } from "@/lib/auth/permissions";

function signedInAs(over: Partial<AuthProfile> = {}) {
  getAuthProfile.mockResolvedValue({
    id: "owner-1",
    email: "owner@oranje.nl",
    full_name: "Owner",
    role: "owner",
    status: "active",
    permissions: [],
    ...over,
  });
}

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/users/u2", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase._resetAll();
  mockSupabase.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
});

describe("users API — access", () => {
  it("401s with no session", async () => {
    getAuthProfile.mockResolvedValue(null);
    expect((await listUsers()).status).toBe(401);
    expect((await patchUser(patchReq({ status: "active" }), params("u2"))).status).toBe(401);
  });

  it("403s an employee even when granted manage_users", async () => {
    // User administration is a ROLE test: the permission key alone is not a way in.
    signedInAs({ id: "e1", role: "employee", permissions: ["manage_users"] });
    expect((await listUsers()).status).toBe(403);
    expect((await patchUser(patchReq({ status: "active" }), params("u2"))).status).toBe(403);
  });

  it("403s an owner whose own account is disabled", async () => {
    signedInAs({ status: "disabled" });
    expect((await listUsers()).status).toBe(403);
  });
});

describe("GET /api/users", () => {
  it("joins auth emails onto profiles and puts pending accounts first", async () => {
    signedInAs();
    mockSupabase._table("user_profiles")._setResult({
      data: [
        {
          id: "u-active", full_name: "Zoe", role: "employee", status: "active", created_at: "2026-01-01",
          user_permissions: [
            { permission_key: "view_invoices", granted: true },
            { permission_key: "delete_data", granted: false },
          ],
        },
        { id: "u-pending", full_name: "Adam", role: "employee", status: "pending", created_at: "2026-02-01", user_permissions: [] },
        { id: "u-disabled", full_name: "Bo", role: "employee", status: "disabled", created_at: "2026-03-01", user_permissions: [] },
      ],
      error: null,
    });
    mockSupabase.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: "u-active", email: "zoe@oranje.nl", last_sign_in_at: "2026-09-01" }] },
      error: null,
    });

    const res = await listUsers();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.map((u: { id: string }) => u.id)).toEqual(["u-pending", "u-active", "u-disabled"]);
    expect(json.data[1]).toMatchObject({ email: "zoe@oranje.nl", permissions: ["view_invoices"] });
    // No auth row → no email, rather than a crash.
    expect(json.data[0].email).toBeNull();
  });
});

describe("PATCH /api/users/:id", () => {
  beforeEach(() => {
    mockSupabase._table("user_profiles")._setResult({
      data: { id: "u2", role: "employee", status: "pending" },
      error: null,
    });
  });

  it("approves a pending user and writes the full permission set in one call", async () => {
    signedInAs();
    const res = await patchUser(
      patchReq({ status: "active", permissions: { view_invoices: true, export_excel: false } }),
      params("u2")
    );

    expect(res.status).toBe(200);
    const profiles = mockSupabase._table("user_profiles");
    expect(profiles._calls.find((c: { method: string }) => c.method === "update")?.args[0]).toEqual({ status: "active" });

    // Unchecked keys are written as `false`, not omitted — the round trip has
    // to be able to REVOKE, not only grant.
    const upsert = mockSupabase._table("user_permissions")._calls.find((c: { method: string }) => c.method === "upsert");
    expect(upsert?.args[0]).toEqual([
      { user_id: "u2", permission_key: "view_invoices", granted: true },
      { user_id: "u2", permission_key: "export_excel", granted: false },
    ]);
  });

  it("rejects an unknown permission key", async () => {
    signedInAs();
    const res = await patchUser(patchReq({ permissions: { be_admin: true } }), params("u2"));
    expect(res.status).toBe(400);
  });

  it("404s an id with no profile", async () => {
    signedInAs();
    mockSupabase._table("user_profiles")._setResult({ data: null, error: null });
    expect((await patchUser(patchReq({ status: "active" }), params("u2"))).status).toBe(404);
  });

  it("refuses to change your OWN role or status", async () => {
    signedInAs({ id: "u2" });
    expect((await patchUser(patchReq({ role: "employee" }), params("u2"))).status).toBe(400);
    expect((await patchUser(patchReq({ status: "disabled" }), params("u2"))).status).toBe(400);
    // Renaming yourself is still fine.
    expect((await patchUser(patchReq({ full_name: "New Name" }), params("u2"))).status).toBe(200);
  });

  it("refuses to disable or demote the LAST active owner", async () => {
    signedInAs();
    const profiles = mockSupabase._table("user_profiles");
    profiles._setResult({ data: { id: "u2", role: "owner", status: "active" }, error: null, count: 1 });

    const demote = await patchUser(patchReq({ role: "employee" }), params("u2"));
    expect(demote.status).toBe(400);
    expect((await demote.json()).error).toMatch(/last active owner/i);

    const disable = await patchUser(patchReq({ status: "disabled" }), params("u2"));
    expect(disable.status).toBe(400);
  });

  it("allows demoting an owner when another active owner remains", async () => {
    signedInAs();
    mockSupabase._table("user_profiles")._setResult({
      data: { id: "u2", role: "owner", status: "active" },
      error: null,
      count: 2,
    });
    expect((await patchUser(patchReq({ role: "employee" }), params("u2"))).status).toBe(200);
  });

  it("rejects an empty patch", async () => {
    signedInAs();
    expect((await patchUser(patchReq({}), params("u2"))).status).toBe(400);
  });
});
