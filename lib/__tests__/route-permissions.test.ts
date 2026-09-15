import { describe, it, expect } from "vitest";
import { isPublicPath, isSessionOnlyPath, requiredPermission } from "@/lib/auth/route-permissions";

describe("route → permission map", () => {
  it("marks only the signed-out screens public", () => {
    for (const p of ["/login", "/signup", "/forgot-password", "/reset-password", "/auth/callback", "/api/auth/x"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of ["/", "/invoices", "/api/invoices", "/loginish", "/settings/users"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it("does not let a prefix match a longer word", () => {
    // "/logind" must not count as "/login".
    expect(isPublicPath("/logind")).toBe(false);
    expect(isPublicPath("/login/extra")).toBe(true);
  });

  it("lets a pending account reach /pending and nothing else", () => {
    expect(isSessionOnlyPath("/pending")).toBe(true);
    expect(isSessionOnlyPath("/")).toBe(false);
    expect(isSessionOnlyPath("/invoices")).toBe(false);
  });

  it("splits API reads, writes and deletes", () => {
    expect(requiredPermission("/api/invoices", "GET")).toBe("view_invoices");
    expect(requiredPermission("/api/invoices", "POST")).toBe("edit_invoices");
    expect(requiredPermission("/api/invoices/abc", "PATCH")).toBe("edit_invoices");
    expect(requiredPermission("/api/invoices/abc", "DELETE")).toBe("delete_data");
  });

  it("routes every export surface to export_excel", () => {
    for (const p of ["/api/export", "/api/generate-excel", "/api/generate-zip", "/api/download-files", "/api/bulk-converter", "/api/relation-converter"]) {
      expect(requiredPermission(p, "POST")).toBe("export_excel");
    }
  });

  it("sends client writes to manage_clients but client reads to view", () => {
    expect(requiredPermission("/api/clients", "GET")).toBe("view_invoices");
    expect(requiredPermission("/api/clients/1/employees", "POST")).toBe("manage_clients");
    expect(requiredPermission("/api/clients/1/employees/2", "DELETE")).toBe("delete_data");
  });

  it("fails CLOSED on an /api path nobody mapped", () => {
    // A route added later is owner/developer-only until someone lists it,
    // rather than silently reachable by every employee.
    expect(requiredPermission("/api/brand-new-thing", "GET")).toBe("delete_data");
  });

  it("gates the pages that have their own permission and leaves the rest open", () => {
    expect(requiredPermission("/settings/users", "GET")).toBe("manage_users");
    expect(requiredPermission("/bulk-converter", "GET")).toBe("export_excel");
    expect(requiredPermission("/invoices", "GET")).toBe("view_invoices");
    expect(requiredPermission("/clients/123", "GET")).toBe("view_invoices");
    // Longest prefix wins: /settings/users is stricter than /settings.
    expect(requiredPermission("/settings", "GET")).toBeNull();
    expect(requiredPermission("/", "GET")).toBeNull();
  });
});
