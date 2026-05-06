import { NextRequest } from "next/server";
import { normalizePhone } from "@/lib/http";

export function filtersFromRequest(req: NextRequest) {
  return {
    phone: normalizePhone(req.nextUrl.searchParams.get("phone")),
    status: req.nextUrl.searchParams.get("status") || undefined,
    from: req.nextUrl.searchParams.get("from") || undefined,
    to: req.nextUrl.searchParams.get("to") || undefined,
    order: req.nextUrl.searchParams.get("order") || "created_at_desc",
    client: req.nextUrl.searchParams.get("client") || undefined,
    invoice: req.nextUrl.searchParams.get("invoice") || undefined,
    direction: req.nextUrl.searchParams.get("direction") || undefined
  };
}

export function applyCommonFilters(
  query: any,
  filters: ReturnType<typeof filtersFromRequest>,
  dateColumn = "created_at"
) {
  let q = query;

  if (filters.phone) q = q.ilike("phone_number", `%${filters.phone}%`);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.from) q = q.gte(dateColumn, filters.from);
  if (filters.to) {
    // For timestamp columns, extend plain date to end-of-day so the full day is included
    const isTimestamp = dateColumn !== "date";
    const toValue =
      isTimestamp && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)
        ? `${filters.to}T23:59:59.999Z`
        : filters.to;
    q = q.lte(dateColumn, toValue);
  }
  if (filters.client)    q = q.ilike("client_name", `%${filters.client}%`);
  if (filters.invoice)   q = q.ilike("invoice_number", `%${filters.invoice}%`);
  if (filters.direction) q = q.eq("invoice_direction", filters.direction);

  return q;
}
