import { NextRequest, NextResponse } from "next/server";
import { jsonError, pagination, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { page, limit, from, to } = pagination(req, 20, 10000);
  const filters = filtersFromRequest(req);
  const dateColumn = req.nextUrl.searchParams.get("date_column") === "created_at" ? "created_at" : "date";
  const ascending = filters.order === "created_at_asc";

  const sortByParam = req.nextUrl.searchParams.get("sort_by") || "date";
  const sortDirParam = req.nextUrl.searchParams.get("sort_dir") || "desc";
  const sortAscending = sortDirParam === "asc";
  const sortColumn =
    sortByParam === "amount" ? "total_amount" :
    sortByParam === "id"     ? "invoice_number" :
    sortByParam === "client" ? "client_name" :
    "date";

  let mainQuery = supabaseAdmin
    .from("invoices")
    .select("id,file_id,phone_number,invoice_number,client_name,date,total_amount,currency,file_url,status,confidence,created_at,invoice_direction", {
      count: "exact"
    });
  mainQuery = applyCommonFilters(mainQuery, filters, dateColumn);

  // Aggregate query for total amount across all matching results (not just this page)
  let aggQuery = supabaseAdmin.from("invoices").select("total_amount");
  aggQuery = applyCommonFilters(aggQuery, filters, dateColumn);

  const [{ data, count, error }, { data: amountRows }] = await Promise.all([
    mainQuery.order(sortColumn, { ascending: sortAscending }).order("created_at", { ascending: false }).range(from, to),
    aggQuery.limit(100000)
  ]);

  if (error) return jsonError(error.message, 500);

  const totalAmount = (amountRows || []).reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);

  return NextResponse.json({
    data,
    total: count ?? 0,
    total_amount: totalAmount,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit)
  });
}
