import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, normalizePhone, pagination, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { computeTotals } from "@/lib/billing";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { uploadBuffer } from "@/lib/storage";

export const runtime = "nodejs";

// Manual invoice creation from the dashboard's "New invoice" form: a CLIENT
// received this inkoop invoice FROM one of its SUPPLIERS. Totals are computed
// server-side (never trusted from the client), a PDF is rendered + stored in
// S3, and file_url is set to that PDF. The n8n OCR pipeline uses a different
// endpoint (/api/invoices/batch) and is unaffected.
const dateField = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")]).optional().nullable();

const lineItemSchema = z.object({
  description: z.string().trim().max(300).optional().default(""),
  quantity:    z.number().finite(),
  unit_price:  z.number().finite(),
});

const createSchema = z.object({
  invoice_number:  z.string().trim().min(1, "Invoice number is required"),
  client_id:       z.string().uuid("A client must be selected"),
  supplier_id:     z.string().uuid("A supplier must be selected"),
  date:            dateField,
  delivery_date:   dateField,
  description:     z.string().trim().max(500).optional().nullable(),
  order_reference: z.string().trim().max(200).optional().nullable(),
  line_items:      z.array(lineItemSchema).min(1, "At least one line item is required"),
  btw_rate:        z.number().min(0).max(100),
  currency:        z.string().trim().length(3).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return jsonError("Invalid invoice payload", 400, parsed.error.flatten());
  const v = parsed.data;

  // Resolve client + supplier; the supplier must belong to the client.
  const { data: client, error: cErr } = await supabaseAdmin
    .from("clients").select("*").eq("id", v.client_id).maybeSingle();
  if (cErr) return jsonError(cErr.message, 500);
  if (!client) return jsonError("Client not found", 404);

  const { data: supplier, error: sErr } = await supabaseAdmin
    .from("suppliers").select("*").eq("id", v.supplier_id).maybeSingle();
  if (sErr) return jsonError(sErr.message, 500);
  if (!supplier) return jsonError("Supplier not found", 404);
  if (supplier.client_id !== v.client_id) {
    return jsonError("Supplier does not belong to the selected client", 400);
  }

  // Server-authoritative totals (truncated to 2dp, matching the PDF).
  const totals = computeTotals(v.line_items, v.btw_rate);
  const invoiceDate = v.date || null;
  const deliveryDate = v.delivery_date || invoiceDate;

  // Insert first (no file_url yet) so a duplicate invoice_number fails cheaply
  // via the unique constraint, before we spend effort rendering a PDF.
  const insertRow = {
    invoice_number:    v.invoice_number,
    client_id:         v.client_id,
    supplier_id:       v.supplier_id,
    client_name:       client.name,                 // denormalised for the list + n8n parity
    supplier_name:     supplier.name,
    phone_number:      (client.phone_number ? normalizePhone(client.phone_number) : "") || "",
    date:              invoiceDate,
    description:       v.description?.trim() || null,
    line_items:        totals.items,
    btw_rate:          totals.btw_rate,
    subtotal:          totals.subtotal,
    btw_amount:        totals.btw_amount,
    total_amount:      totals.total,
    currency:          (v.currency || "EUR").toUpperCase(),
    invoice_direction: "inkoop",
    status:            "extracted",
    file_url:          "",
    confidence:        null,
    raw_extraction:    { source: "manual", order_reference: v.order_reference ?? null, delivery_date: deliveryDate },
  };

  const { data: created, error } = await supabaseAdmin
    .from("invoices").insert(insertRow).select("id,invoice_number").single();
  if (error) {
    if (error.code === "23505") return jsonError(`Invoice number "${v.invoice_number}" already exists`, 409);
    return jsonError(error.message, 500);
  }

  // Render the PDF and store it in S3; set file_url to the stored object.
  try {
    const pdf = await buildInvoicePdf({
      supplier,
      client,
      meta: {
        invoice_number:  v.invoice_number,
        invoice_date:    invoiceDate,
        delivery_date:   deliveryDate,
        order_reference: v.order_reference ?? null,
        description:     v.description ?? null,
      },
      totals,
    });
    const now = new Date();
    const key = `generated-invoices/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${created.id}.pdf`;
    const fileUrl = await uploadBuffer({ key, body: pdf, contentType: "application/pdf" });
    await supabaseAdmin.from("invoices").update({ file_url: fileUrl }).eq("id", created.id);
    return NextResponse.json({ id: created.id, invoice_number: created.invoice_number, file_url: fileUrl }, { status: 201 });
  } catch (e) {
    // The invoice row exists; only the PDF failed. Surface it without 500-ing
    // the whole create so the user isn't left unsure whether it saved.
    console.error("[invoices.POST] PDF generation/upload failed:", e);
    return NextResponse.json(
      { id: created.id, invoice_number: created.invoice_number, file_url: "", warning: "Invoice created, but PDF generation failed." },
      { status: 201 },
    );
  }
}

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const { page, limit, from, to } = pagination(req, 20, 10000);
  const filters = filtersFromRequest(req);
  const dateColumn = req.nextUrl.searchParams.get("date_column") === "created_at" ? "created_at" : "date";

  const sortByParam = req.nextUrl.searchParams.get("sort_by") || "date";
  const sortDirParam = req.nextUrl.searchParams.get("sort_dir") || "desc";
  const sortAscending = sortDirParam === "asc";
  const sortColumn =
    sortByParam === "amount" ? "total_amount" :
    sortByParam === "id"     ? "invoice_number" :
    sortByParam === "client" ? "client_name" :
    "date";

  // The "client" filter searches BOTH the extracted invoice client name AND
  // the sender's name in the clients table (matched via phone_number). This
  // lets the user type a sender name (e.g. "ضياء") and find their invoices.
  let extraPhonesFromSender: string[] | null = null;
  if (filters.client) {
    const { data: senderHits } = await supabaseAdmin
      .from("clients")
      .select("phone_number")
      .ilike("name", `%${filters.client}%`)
      .not("phone_number", "is", null)
      .limit(500);
    extraPhonesFromSender = (senderHits || [])
      .map((row: { phone_number: string | null }) => normalizePhone(row.phone_number))
      .filter((p): p is string => !!p);
  }

  function applyFilters<Q extends { or?: (s: string) => Q }>(query: Q): Q {
    let q = applyCommonFilters(query, { ...filters, client: undefined }, dateColumn);
    if (filters.client) {
      const pattern = `%${filters.client.replace(/[%_]/g, "")}%`;
      const orParts = [`client_name.ilike.${pattern}`];
      if (extraPhonesFromSender && extraPhonesFromSender.length > 0) {
        const phoneList = extraPhonesFromSender.map((p) => `"${p}"`).join(",");
        orParts.push(`phone_number.in.(${phoneList})`);
      }
      q = (q.or ? q.or(orParts.join(",")) : q) as Q;
    }
    return q;
  }

  let mainQuery = supabaseAdmin
    .from("invoices")
    .select("id,file_id,phone_number,invoice_number,client_id,client_name,date,total_amount,currency,file_url,status,confidence,created_at,invoice_direction", {
      count: "exact"
    });
  mainQuery = applyFilters(mainQuery);

  let aggQuery = supabaseAdmin.from("invoices").select("total_amount");
  aggQuery = applyFilters(aggQuery);

  const [{ data, count, error }, { data: amountRows }] = await Promise.all([
    mainQuery.order(sortColumn, { ascending: sortAscending }).order("created_at", { ascending: false }).range(from, to),
    aggQuery.limit(100000)
  ]);

  if (error) return jsonError(error.message, 500);

  const totalAmount = (amountRows || []).reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);

  // Resolve sender_name for each invoice via phone_number → clients.name map.
  const rows = data || [];
  const phones = Array.from(
    new Set(rows.map((r: { phone_number: string | null }) => r.phone_number).filter(Boolean))
  ) as string[];

  let senderByPhone: Record<string, string> = {};
  if (phones.length > 0) {
    const { data: clientRows } = await supabaseAdmin
      .from("clients")
      .select("phone_number, name")
      .in("phone_number", phones);
    senderByPhone = (clientRows || []).reduce<Record<string, string>>((acc, c) => {
      if (c.phone_number) acc[c.phone_number] = c.name;
      return acc;
    }, {});
  }

  // Resolve the structured client name via client_id (manual invoices). Falls
  // back to the free-text client_name column for n8n OCR rows (client_id null).
  const clientIds = Array.from(
    new Set(rows.map((r: { client_id?: string | null }) => r.client_id).filter(Boolean))
  ) as string[];
  let nameByClientId: Record<string, string> = {};
  if (clientIds.length > 0) {
    const { data: byId } = await supabaseAdmin.from("clients").select("id, name").in("id", clientIds);
    nameByClientId = (byId || []).reduce<Record<string, string>>((acc, c) => {
      acc[c.id] = c.name;
      return acc;
    }, {});
  }

  const enriched = rows.map((r: { phone_number: string | null; client_id?: string | null; client_name: string | null; [k: string]: unknown }) => {
    const resolvedClientName = (r.client_id && nameByClientId[r.client_id]) || r.client_name;
    return {
      ...r,
      client_name: resolvedClientName,
      sender_name: r.phone_number ? senderByPhone[r.phone_number] ?? null : null,
    };
  });

  return NextResponse.json({
    data: enriched,
    total: count ?? 0,
    total_amount: totalAmount,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit)
  });
}
