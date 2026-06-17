import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const patchSchema = z.object({
  name:         z.string().min(1).max(200).optional(),
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; customerId: string }> }
) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, customerId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid customer data", 400, parsed.error.flatten());

  const { email, ...rest } = parsed.data;
  const payload = {
    ...rest,
    ...(email !== undefined ? { email: email || null } : {}),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from("customers")
    .update(payload)
    .eq("id", customerId)
    .eq("client_id", id)
    .select("*")
    .single();

  if (error) return jsonError(error.code === "PGRST116" ? "Customer not found" : error.message, error.code === "PGRST116" ? 404 : 500);
  return NextResponse.json(data);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; customerId: string }> }
) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id, customerId } = await params;
  const { error } = await supabaseAdmin
    .from("customers")
    .delete()
    .eq("id", customerId)
    .eq("client_id", id);

  if (error) return jsonError(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
