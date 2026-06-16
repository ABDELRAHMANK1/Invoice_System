import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, normalizePhone, pagination, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

// Manual invoice creation from the dashboard's "New invoice" form. Unlike the
// n8n batch upsert, there is no source file, so file_url is stored empty and
// raw_extraction records that the row was hand-entered.
const createSchema = z.object({
  invoice_number:    z.string().trim().min(1, "Invoice number is required"),
  client_name:       z.string().trim().optional().nullable(),
  phone_number:      z.string().trim().optional().nullable(),
  date:              z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")])
                       .optional().nullable(),
  total_amount:      z.number().nonnegative().optional().nullable(),
  currency:          z.string().trim().length(3).optional().nullable(),
  invoice_direction: z.enum(["inkoop", "verkoop"]).optional().nullable(),
  status:            z.enum(["extracted", "pending", "error"]).optional(),
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return jsonError("Invalid invoice payload", 400, parsed.error.flatten());

  const v = parsed.data;
  const row = {
    invoice_number:    v.invoice_number,
    client_name:       v.client_name?.trim() || null,
    phone_number:      (v.phone_number ? normalizePhone(v.phone_number) : "") || "",
    date:              v.date || null,
    total_amount:      v.total_amount ?? null,
    currency:          (v.currency || "EUR").toUpperCase(),
    invoice_direction: v.invoice_direction ?? "inkoop",
    status:            v.status ?? "extracted",
    file_url:          "",
    confidence:        null,
    raw_extraction:    { source: "manual" },
  };

  const { data, error } = await supabaseAdmin
    .from("invoices")
    .insert(row)
    .select("id,invoice_number,client_name,date,total_amount,currency,status,invoice_direction")
    .single();

  if (error) {
    // 23505 = unique_violation on invoices_invoice_number_unique
    if (error.code === "23505") {
      return jsonError(`Invoice number "${v.invoice_number}" already exists`, 409);
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ data }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { page, limit, from, to } = pagination(req, 20, 10000);
  const filters = filtersFromRequest(req);
  const dateColumn = req.nextUrl.searchParams.get("date_column") === "created_at" ? "created_at" : "date";

  const sortByParam = req.nextUrl.searchParams.get("sort_by") || "date";
  const sortDirParam = req.nextUrl.searchParams.get("sort_dir") || "desc";
  const sortAscending = sortDirParam === "asc";
  const sortColumn =
    sortByParam === "amount" ? "total_amount" :
    sortByParam === "id"     ? "invoice_number" :
    sortByParam === "client" ? "client_name" :
    "date";

  // The "client" filter searches BOTH the extracted invoice client name AND
  // the sender's name in the clients table (matched via phone_number). This
  // lets the user type a sender name (e.g. "ضياء") and find their invoices.
  let extraPhonesFromSender: string[] | null = null;
  if (filters.client) {
    const { data: senderHits } = await supabaseAdmin
      .from("clients")
      .select("phone_number")
      .ilike("name", `%${filters.client}%`)
      .not("phone_number", "is", null)
      .limit(500);
    extraPhonesFromSender = (senderHits || [])
      .map((row: { phone_number: string | null }) => normalizePhone(row.phone_number))
      .filter((p): p is string => !!p);
  }

  function applyFilters<Q extends { or?: (s: string) => Q }>(query: Q): Q {
    let q = applyCommonFilters(query, { ...filters, client: undefined }, dateColumn);
    if (filters.client) {
      const pattern = `%${filters.client.replace(/[%_]/g, "")}%`;
      const orParts = [`client_name.ilike.${pattern}`];
      if (extraPhonesFromSender && extraPhonesFromSender.length > 0) {
        const phoneList = extraPhonesFromSender.map((p) => `"${p}"`).join(",");
        orParts.push(`phone_number.in.(${phoneList})`);
      }
      q = (q.or ? q.or(orParts.join(",")) : q) as Q;
    }
    return q;
  }

  let mainQuery = supabaseAdmin
    .from("invoices")
    .select("id,file_id,phone_number,invoice_number,client_name,date,total_amount,currency,file_url,status,confidence,created_at,invoice_direction", {
      count: "exact"
    });
  mainQuery = applyFilters(mainQuery);

  let aggQuery = supabaseAdmin.from("invoices").select("total_amount");
  aggQuery = applyFilters(aggQuery);

  const [{ data, count, error }, { data: amountRows }] = await Promise.all([
    mainQuery.order(sortColumn, { ascending: sortAscending }).order("created_at", { ascending: false }).range(from, to),
    aggQuery.limit(100000)
  ]);

  if (error) return jsonError(error.message, 500);

  const totalAmount = (amountRows || []).reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);

  // Resolve sender_name for each invoice via phone_number → clients.name map.
  const rows = data || [];
  const phones = Array.from(
    new Set(rows.map((r: { phone_number: string | null }) => r.phone_number).filter(Boolean))
  ) as string[];

  let senderByPhone: Record<string, string> = {};
  if (phones.length > 0) {
    const { data: clientRows } = await supabaseAdmin
      .from("clients")
      .select("phone_number, name")
      .in("phone_number", phones);
    senderByPhone = (clientRows || []).reduce<Record<string, string>>((acc, c) => {
      if (c.phone_number) acc[c.phone_number] = c.name;
      return acc;
    }, {});
  }

  const enriched = rows.map((r: { phone_number: string | null; client_name: string | null; [k: string]: unknown }) => ({
    ...r,
    sender_name: r.phone_number ? senderByPhone[r.phone_number] ?? null : null,
  }));

  return NextResponse.json({
    data: enriched,
    total: count ?? 0,
    total_amount: totalAmount,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit)
  });
}
