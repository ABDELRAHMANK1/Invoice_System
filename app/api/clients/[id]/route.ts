import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const patchSchema = z.object({
  name:         z.string().min(1).max(200).optional(),
  phone_number: z.string().max(32).optional().nullable(),
  email:        z.string().email().optional().nullable().or(z.literal("")),
  address:      z.string().max(500).optional().nullable(),
  city:         z.string().max(200).optional().nullable(),
  country:      z.string().length(2).optional(),
  btw_number:   z.string().max(50).optional().nullable(),
  kvk_number:   z.string().max(20).optional().nullable(),
  notes:        z.string().max(2000).optional().nullable(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return jsonError(error.code === "PGRST116" ? "Client not found" : error.message, error.code === "PGRST116" ? 404 : 500);
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid client data", 400, parsed.error.flatten());

  const { email, ...rest } = parsed.data;
  const payload = { ...rest, ...(email !== undefined ? { email: email || null } : {}) };

  const { data, error } = await supabaseAdmin
    .from("clients")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;
  const { error } = await supabaseAdmin.from("clients").delete().eq("id", id);
  if (error) return jsonError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
