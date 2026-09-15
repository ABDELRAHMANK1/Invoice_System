import { describe, it, expect } from "vitest";
import {
  PERMISSION_KEYS,
  type AuthProfile,
  can,
  canManageUsers,
  grantedKeys,
  hasFullAccess,
  isPermissionKey,
  isRole,
  isUserStatus,
} from "@/lib/auth/permissions";

function profile(over: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "u1",
    email: "a@b.nl",
    full_name: "Ammar",
    role: "employee",
    status: "active",
    permissions: [],
    ...over,
  };
}

describe("permission model", () => {
  it("lets owner and developer through without any permission rows", () => {
    for (const role of ["owner", "developer"] as const) {
      const p = profile({ role, permissions: [] });
      expect(hasFullAccess(role)).toBe(true);
      for (const key of PERMISSION_KEYS) expect(can(p, key)).toBe(true);
    }
  });

  it("checks an employee against its granted keys only", () => {
    const p = profile({ permissions: ["view_invoices"] });
    expect(can(p, "view_invoices")).toBe(true);
    expect(can(p, "export_excel")).toBe(false);
    expect(can(p, "delete_data")).toBe(false);
  });

  it("denies everything to a pending or disabled account, whatever the role", () => {
    // The status gate runs BEFORE the role bypass — disabling an owner has to
    // actually lock them out.
    for (const status of ["pending", "disabled"] as const) {
      const owner = profile({ role: "owner", status });
      expect(can(owner, "view_invoices")).toBe(false);
      expect(can(owner, null)).toBe(false);
      expect(canManageUsers(owner)).toBe(false);
    }
  });

  it("treats a null permission as 'any active account'", () => {
    expect(can(profile({ permissions: [] }), null)).toBe(true);
    expect(can(null, null)).toBe(false);
  });

  it("only owner/developer manage users, even with the permission granted", () => {
    expect(canManageUsers(profile({ permissions: ["manage_users"] }))).toBe(false);
    expect(canManageUsers(profile({ role: "owner" }))).toBe(true);
    expect(canManageUsers(profile({ role: "developer" }))).toBe(true);
  });

  it("reads granted rows and ignores denied or unknown keys", () => {
    expect(
      grantedKeys([
        { permission_key: "view_invoices", granted: true },
        { permission_key: "export_excel", granted: false },
        { permission_key: "fly_a_plane", granted: true },
      ])
    ).toEqual(["view_invoices"]);
    expect(grantedKeys(null)).toEqual([]);
  });

  it("guards its own enums", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isUserStatus("pending")).toBe(true);
    expect(isUserStatus("paused")).toBe(false);
    expect(isPermissionKey("delete_data")).toBe(true);
    expect(isPermissionKey("delete_everything")).toBe(false);
  });
});
