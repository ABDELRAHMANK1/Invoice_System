import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { phoneDigits, phonePattern } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type ClientRow = {
  id: string;
  name: string | null;
  relatie_code: string | null;
  whatsapp_phone: string | null;
  phone_number: string | null;
};

/**
 * GET /api/clients/by-whatsapp?phone=31612345678
 *
 * Resolves a WhatsApp sender (digits only, no "+") to a known client, so n8n
 * can label an inbound invoice before it reaches the parser. Read-only.
 *
 * An unknown sender is a normal outcome, not an error: it answers 200 with
 * `{ found: false }` so the workflow can branch on the body instead of
 * treating a 404 as a failed HTTP node.
 */
export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const digits = phoneDigits(req.nextUrl.searchParams.get("phone"));
  if (!digits) return jsonError("phone query parameter is required", 400);

  const pattern = phonePattern(digits);

  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id,name,relatie_code,whatsapp_phone,phone_number")
    .or(`whatsapp_phone.ilike.${pattern},phone_number.ilike.${pattern}`)
    .limit(20);

  if (error) return jsonError(error.message, 500);

  // The ilike pattern only narrows candidates — it tolerates separators but
  // also permits extra digits in between. Digits-only equality is the
  // authoritative comparison, and whatsapp_phone wins over phone_number.
  const rows = (data ?? []) as ClientRow[];
  const match =
    rows.find((c) => phoneDigits(c.whatsapp_phone) === digits) ??
    rows.find((c) => phoneDigits(c.phone_number) === digits);

  if (!match) return NextResponse.json({ found: false });

  return NextResponse.json({
    found: true,
    client_id: match.id,
    name: match.name,
    relatie_code: match.relatie_code ?? null,
  });
}
