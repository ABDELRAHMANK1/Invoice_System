import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireInternalApiKey, jsonError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

const SaveFileSchema = z.object({
  phone_number:      z.string().min(1),
  file_key:          z.string().min(1),
  file_type:         z.enum(["image", "pdf", "document"]),
  file_name:         z.string().optional().nullable(),
  mime_type:         z.string().optional().nullable(),
  invoice_direction: z.enum(["inkoop", "verkoop"]).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = SaveFileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

const { phone_number, file_key, file_type, file_name, mime_type, invoice_direction } = parsed.data;

  const { data, error } = await supabaseAdmin
    .from("files")
    .insert({
      phone_number,
      file_key,
      file_type,
      file_name:  file_name  ?? null,
      mime_type:  mime_type  ?? null,
      invoice_direction: invoice_direction ?? "inkoop",
      status:     "pending"
    })
    .select("id, phone_number, file_key, file_type, status, created_at")
    .single();

  if (error) {
    console.error("[POST /api/files] Supabase error:", error);
    return jsonError("Failed to save file metadata", 500);
  }

  return NextResponse.json(data, { status: 201 });
}

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const phone     = searchParams.get("phone")     || null;
  const from      = searchParams.get("from")      || null;
  const to        = searchParams.get("to")        || null;
  const status    = searchParams.get("status")    || null;
  const direction = searchParams.get("direction") || null;
  const page  = Math.max(1, parseInt(searchParams.get("page")  || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
  const order = searchParams.get("order") === "created_at_asc";

  let query = supabaseAdmin
    .from("files")
    .select("*", { count: "exact" })
    .range((page - 1) * limit, page * limit - 1)
    .order("created_at", { ascending: order });

  if (phone)     query = query.eq("phone_number", phone);
  if (status)    query = query.eq("status", status);
  if (direction) query = query.eq("invoice_direction", direction);
  if (from)      query = query.gte("created_at", from);
  if (to) {
    const toValue = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
    query = query.lte("created_at", toValue);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[GET /api/files] Supabase error:", error);
    return jsonError("Failed to fetch files", 500);
  }

  return NextResponse.json({
    data,
    total: count ?? 0,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit)
  });
}
