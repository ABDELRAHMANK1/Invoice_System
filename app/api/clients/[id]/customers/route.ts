import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

// Customers (Klanten) — the parties a client SELLS to. Mirror of the suppliers
// endpoint, pointed at the `customers` table (see migration 005). The verkoop
// invoice flow isn't built yet; this just manages the counterparty records.
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
    .from("customers")
    .select("*")
    .eq("client_id", id)
    .order("name", { ascending: true });

  if (error) {
    console.error(`[customers.GET] client_id=${id} supabase error:`, error);
    return jsonError(error.message, 500);
  }
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { id } = await params;

  // Read the body, surfacing parse failures explicitly instead of silently coercing to {}.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (e) {
    console.warn(`[customers.POST] client_id=${id} invalid JSON body:`, e instanceof Error ? e.message : e);
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn(`[customers.POST] client_id=${id} validation failed:`, parsed.error.flatten());
    return jsonError("Invalid customer data", 400, parsed.error.flatten());
  }

  // Pre-check the client exists — surfaces the real cause when a stale dashboard
  // tries to insert against a deleted client_id (which previously bubbled up as
  // a confusing "violates foreign key constraint" 500).
  const { data: clientRow, error: clientErr } = await supabaseAdmin
    .from("clients")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (clientErr) {
    console.error(`[customers.POST] client lookup failed for client_id=${id}:`, clientErr);
    return jsonError(clientErr.message, 500);
  }
  if (!clientRow) {
    console.warn(`[customers.POST] client_id=${id} not found — refusing insert`);
    return jsonError("Client not found", 404);
  }

  const { email, ...rest } = parsed.data;
  const payload = { ...rest, client_id: id, email: email || null };

  const { data, error } = await supabaseAdmin
    .from("customers")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    console.error(`[customers.POST] insert failed for client_id=${id}:`, error);
    // Foreign-key violation → translate to 404 so the dashboard sees a meaningful error.
    if (error.code === "23503") return jsonError("Client not found or has been deleted", 404);
    return jsonError(error.message, 500);
  }

  // Defensive: insert with RETURNING should always give us the row.
  if (!data) {
    console.error(`[customers.POST] insert returned no row for client_id=${id} — Supabase response was empty`);
    return jsonError("Customer insert returned no data", 500);
  }

  return NextResponse.json(data, { status: 201 });
}
