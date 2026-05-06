import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const invoiceSchema = z.object({
  file_id: z.string().uuid().optional().nullable(),
  phone_number: z.string().min(5),
  invoice_number: z.string().min(1),
  client_name: z.string().optional().nullable(),
  date: z.string().optional().nullable(),
  total_amount: z.number().optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  file_url: z.string().min(8),
  confidence: z.number().min(0).max(1).optional().nullable(),
  status: z.enum(["extracted", "pending", "error"]).optional()
});

const schema = z.object({
  invoices: z.array(invoiceSchema).max(200)
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid invoice batch payload", 400, parsed.error.flatten());

  const rows = parsed.data.invoices.map((invoice) => ({
    ...invoice,
    status: invoice.status || "extracted",
    currency: invoice.currency || "EUR",
    raw_extraction: invoice
  }));

  if (rows.length === 0) return NextResponse.json({ inserted: 0, data: [] });

  const { data, error } = await supabaseAdmin
    .from("invoices")
    .upsert(rows, { onConflict: "invoice_number" })
    .select("id,invoice_number,file_id,status");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ inserted: data?.length ?? 0, data });
}
