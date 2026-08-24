import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { phoneDigits, phonePattern } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

// Exact column names, checked against the live schema — `clients` has
// `kvk_number` while `customers` has plain `kvk`, and the client's phone column
// is `phone_number`. Don't "harmonise" these; they differ in the DB.
const CLIENT_FIELDS =
  "id,name,address,postcode,city,phone_number,email,iban,btw_number,kvk_number,relatie_code";

// whatsapp_phone is selected for the match but deliberately not returned — the
// caller already knows the number it asked about.
const CLIENT_SELECT = `${CLIENT_FIELDS},whatsapp_phone`;

const CUSTOMER_SELECT =
  "id,name,address,postcode,city,btw_number,kvk,relatie_code," +
  "btw_rate,btw_verlegd,pricing_model,default_rate,payment_days,aliases,message_pattern";

type ClientRow = {
  id: string;
  name: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  phone_number: string | null;
  email: string | null;
  iban: string | null;
  btw_number: string | null;
  kvk_number: string | null;
  relatie_code: string | null;
  whatsapp_phone: string | null;
};

/**
 * GET /api/clients/by-whatsapp?phone=31612345678
 *
 * Resolves a WhatsApp sender (digits only, no "+") to a known client and
 * returns that client's full invoicing data plus its active customers, so the
 * n8n invoice flow can identify the sender instead of guessing. Read-only.
 *
 * An unknown sender is a normal outcome, not an error: it answers 200 with
 * `{ found: false }` so the workflow can branch on the body instead of
 * treating a 404 as a failed HTTP node.
 *
 * `client_id` / `name` / `relatie_code` are also kept at the top level, where
 * they were before the client + customers objects were added — the n8n Merge
 * Lookup node reads them from there.
 */
export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const digits = phoneDigits(req.nextUrl.searchParams.get("phone"));
  if (!digits) return jsonError("phone query parameter is required", 400);

  const pattern = phonePattern(digits);

  const { data, error } = await supabaseAdmin
    .from("clients")
    .select(CLIENT_SELECT)
    .or(`whatsapp_phone.ilike.${pattern},phone_number.ilike.${pattern}`)
    .limit(20);

  if (error) return jsonError(error.message, 500);

  // The ilike pattern only narrows candidates — it tolerates separators but
  // also permits extra digits in between. Digits-only equality is the
  // authoritative comparison, and whatsapp_phone wins over phone_number.
  const rows = (data ?? []) as unknown as ClientRow[];
  const match =
    rows.find((c) => phoneDigits(c.whatsapp_phone) === digits) ??
    rows.find((c) => phoneDigits(c.phone_number) === digits);

  if (!match) return NextResponse.json({ found: false });

  const { data: customers, error: customersError } = await supabaseAdmin
    .from("customers")
    .select(CUSTOMER_SELECT)
    .eq("client_id", match.id)
    .eq("active", true)
    .order("name", { ascending: true });

  // Fail loudly rather than answering with an empty list — n8n can't tell
  // "this client has no customers" from "the customer lookup broke".
  if (customersError) return jsonError(customersError.message, 500);

  const { whatsapp_phone: _whatsappPhone, ...client } = match;

  return NextResponse.json({
    found: true,
    client_id: client.id,
    name: client.name,
    relatie_code: client.relatie_code,
    client,
    customers: customers ?? [],
  });
}
