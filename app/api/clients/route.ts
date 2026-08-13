import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey, pagination } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const createSchema = z.object({
  name:         z.string().min(1).max(200),
  phone_number: z.string().max(32).optional().nullable(),
  email:        z.string().email().optional().nullable().or(z.literal("")),
  address:      z.string().max(500).optional().nullable(),
  postcode:     z.string().max(20).optional().nullable(),
  city:         z.string().max(200).optional().nullable(),
  country:      z.string().length(2).default("NL"),
  btw_number:   z.string().max(50).optional().nullable(),
  kvk_number:   z.string().max(20).optional().nullable(),
  rsin:         z.string().max(20).optional().nullable(),
  iban:         z.string().max(50).optional().nullable(),
  relatie_code: z.string().max(50).optional().nullable(),
  notes:        z.string().max(2000).optional().nullable(),
});

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { page, limit, from, to } = pagination(req, 50, 500);
  const q = req.nextUrl.searchParams.get("q") || "";

  let query = supabaseAdmin
    .from("clients")
    .select("*", { count: "exact" })
    .order("name", { ascending: true })
    .range(from, to);

  if (q) {
    query = query.or(`name.ilike.%${q}%,phone_number.ilike.%${q}%,email.ilike.%${q}%,city.ilike.%${q}%`);
  }

  const { data, error, count } = await query;
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    data,
    total: count ?? 0,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit),
  });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid client data", 400, parsed.error.flatten());

  const { email, ...rest } = parsed.data;
  const payload = { ...rest, email: email || null };

  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert(payload)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
