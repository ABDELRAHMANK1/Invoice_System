import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const createSchema = z.object({
  name:         z.string().min(1).max(200),
  relatie_code: z.string().max(50).optional().nullable(),
  address:      z.string().max(500).optional().nullable(),
  postcode:     z.string().max(20).optional().nullable(),
  city:         z.string().max(200).optional().nullable(),
  kvk:          z.string().max(20).optional().nullable(),
  btw_number:   z.string().max(50).optional().nullable(),
  iban:         z.string().max(50).optional().nullable(),
  email:        z.string().email().optional().nullable().or(z.literal("")),
  phone:        z.string().max(32).optional().nullable(),
  payment_days: z.number().int().min(0).max(365).optional().nullable(),
  active:       z.boolean().optional(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const { data, error } = await supabaseAdmin
    .from("suppliers")
    .select("*")
    .eq("client_id", id)
    .order("name", { ascending: true });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid supplier data", 400, parsed.error.flatten());

  const { email, ...rest } = parsed.data;
  const payload = { ...rest, client_id: id, email: email || null };

  const { data, error } = await supabaseAdmin
    .from("suppliers")
    .insert(payload)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
