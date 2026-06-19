import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uploadInvoiceExcelExport, uploadZipExport, type InvoiceExportRow } from "@/lib/export-builders";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { env } from "@/lib/env";
import { scoreMatch } from "@/lib/relatie-match";

export const runtime = "nodejs";

type RelationRow = { id: string; client_id: string; name: string; relatie_code: string | null };

/**
 * Resolve a Snelstart Relatiecode per invoice, matched on phone_number →
 * client_id and then the counterparty:
 *   • inkoop  → the client's SUPPLIERS, fuzzy-matched on supplier_name.
 *   • verkoop → the client's CUSTOMERS, by customer_id when set, else
 *               fuzzy-matched on the counterparty name (mirrors inkoop).
 */
async function attachRelatieCodes(rows: InvoiceExportRow[]): Promise<InvoiceExportRow[]> {
  console.log(`[export.relatie] === attachRelatieCodes START === rows=${rows.length}`);
  if (rows.length === 0) return rows;

  const phoneNumbers = Array.from(new Set(rows.map((r) => r.phone_number).filter(Boolean)));
  console.log(`[export.relatie] phone_numbers from invoices (${phoneNumbers.length}): ${JSON.stringify(phoneNumbers)}`);
  if (phoneNumbers.length === 0) {
    console.log("[export.relatie] no phone numbers on invoices — skipping lookup");
    return rows;
  }

  const { data: clientRows, error: clientErr } = await supabaseAdmin
    .from("clients")
    .select("id,phone_number,relatie_code")
    .in("phone_number", phoneNumbers);
  if (clientErr) {
    console.log(`[export.relatie] CLIENT QUERY ERROR: ${clientErr.message}`);
    return rows;
  }
  if (!clientRows || clientRows.length === 0) {
    console.log(`[export.relatie] NO CLIENTS matched phones ${JSON.stringify(phoneNumbers)} — supplier lookup will be empty`);
    return rows;
  }
  console.log(`[export.relatie] resolved clients (${clientRows.length}): ${JSON.stringify(clientRows.map((c) => ({ id: c.id, phone: c.phone_number, code: c.relatie_code })))}`);

  const phoneToClient = new Map<string, { id: string; relatie_code: string | null }>();
  for (const c of clientRows) {
    if (c.phone_number) phoneToClient.set(c.phone_number, { id: c.id, relatie_code: c.relatie_code ?? null });
  }
  const clientIds = Array.from(new Set(clientRows.map((c) => c.id)));

  // Fetch BOTH counterparty tables for the resolved clients in parallel:
  // suppliers (inkoop) and customers (verkoop). Group by client_id, and index
  // customers by id for the verkoop customer_id direct lookup.
  const [{ data: supplierRows, error: supplierErr }, { data: customerRows, error: customerErr }] = await Promise.all([
    supabaseAdmin.from("suppliers").select("id,client_id,name,relatie_code").in("client_id", clientIds),
    supabaseAdmin.from("customers").select("id,client_id,name,relatie_code").in("client_id", clientIds),
  ]);
  if (supplierErr) console.log(`[export.relatie] SUPPLIER QUERY ERROR: ${supplierErr.message}`);
  if (customerErr) console.log(`[export.relatie] CUSTOMER QUERY ERROR: ${customerErr.message}`);
  console.log(`[export.relatie] supplier rows=${(supplierRows ?? []).length} customer rows=${(customerRows ?? []).length} for client_ids=${JSON.stringify(clientIds)}`);

  const suppliersByClient = new Map<string, RelationRow[]>();
  for (const s of (supplierRows ?? []) as RelationRow[]) {
    const list = suppliersByClient.get(s.client_id) ?? [];
    list.push(s);
    suppliersByClient.set(s.client_id, list);
  }

  const customersByClient = new Map<string, RelationRow[]>();
  const customersById = new Map<string, RelationRow>();
  for (const c of (customerRows ?? []) as RelationRow[]) {
    const list = customersByClient.get(c.client_id) ?? [];
    list.push(c);
    customersByClient.set(c.client_id, list);
    customersById.set(c.id, c);
  }

  // Fuzzy-match a counterparty name against a client's relation list; returns
  // the matched relatie_code or null. Mirrors the inkoop pattern for both sides.
  function fuzzyCode(candidates: RelationRow[], invoiceName: string | null | undefined, label: string, invNo: string): string | null {
    if (!invoiceName) {
      console.log(`[export.relatie] inv=${invNo} ${label}=<empty> match=none`);
      return null;
    }
    let best: { row: RelationRow; score: number } | null = null;
    for (const cand of candidates) {
      const score = scoreMatch(cand.name, invoiceName);
      if (score > 0 && (best === null || score > best.score)) best = { row: cand, score };
    }
    if (!best) {
      console.log(`[export.relatie] inv=${invNo} ${label}="${invoiceName}" match=NONE`);
      return null;
    }
    console.log(`[export.relatie] inv=${invNo} ${label}="${invoiceName}" matched="${best.row.name}" code=${best.row.relatie_code ?? "<null>"} score=${best.score}`);
    return best.row.relatie_code;
  }

  return rows.map((row) => {
    const client = phoneToClient.get(row.phone_number);
    if (!client) {
      console.log(`[export.relatie] inv=${row.invoice_number} phone="${row.phone_number}" — no client mapped, skipping`);
      return row;
    }

    const direction = row.invoice_direction ?? "inkoop";

    if (direction === "verkoop") {
      // Primary: the customer FK set on the invoice (manual verkoop).
      if (row.customer_id) {
        const cust = customersById.get(row.customer_id);
        if (cust?.relatie_code) {
          console.log(`[export.relatie] inv=${row.invoice_number} verkoop customer_id=${row.customer_id} → code=${cust.relatie_code}`);
          return { ...row, relatie_code: cust.relatie_code };
        }
      }
      // Fallback: fuzzy-match the counterparty name against the client's customers.
      const code = fuzzyCode(customersByClient.get(client.id) ?? [], row.customer_name ?? row.client_name, "customer", row.invoice_number);
      return code ? { ...row, relatie_code: code } : row;
    }

    // inkoop: fuzzy-match supplier_name against the client's suppliers.
    const code = fuzzyCode(suppliersByClient.get(client.id) ?? [], row.supplier_name, "supplier", row.invoice_number);
    return code ? { ...row, relatie_code: code } : row;
  });
}

const schema = z.object({
  phone:     z.string().optional().nullable(),
  from:      z.string().optional().nullable(),
  to:        z.string().optional().nullable(),
  client:    z.string().optional().nullable(),
  invoice:   z.string().optional().nullable(),
  direction: z.enum(["inkoop", "verkoop"]).optional().nullable(),
  ids:       z.array(z.string().uuid()).optional().nullable(),
  type:      z.enum(["excel", "zip"]).default("excel"),
  async_job: z.boolean().default(true)
});

function requestFromFilters(
  req: NextRequest,
  filters: { phone?: string | null; from?: string | null; to?: string | null; client?: string | null; invoice?: string | null; direction?: string | null }
) {
  const url = new URL(req.url);
  if (filters.phone)     url.searchParams.set("phone", filters.phone);
  if (filters.from)      url.searchParams.set("from", filters.from);
  if (filters.to)        url.searchParams.set("to", filters.to);
  if (filters.client)    url.searchParams.set("client", filters.client);
  if (filters.invoice)   url.searchParams.set("invoice", filters.invoice);
  if (filters.direction) url.searchParams.set("direction", filters.direction);
  return new NextRequest(url);
}

async function runInlineExport(req: NextRequest, jobId: string, body: z.infer<typeof schema>) {
  const filterReq = requestFromFilters(req, body);
  const filters = filtersFromRequest(filterReq);

  if (body.type === "excel") {
    let query = supabaseAdmin
      .from("invoices")
      .select("id,invoice_number,client_name,supplier_name,customer_id,customer_name,phone_number,date,total_amount,currency,file_url,created_at,status,raw_extraction,invoice_direction");
    if (body.ids && body.ids.length > 0) {
      query = query.in("id", body.ids);
    } else {
      query = applyCommonFilters(query, filters, "date");
    }
    const { data, error } = await query.order("created_at", { ascending: false }).limit(10000);
    if (error) throw new Error(error.message);

    const invoices = await attachRelatieCodes(data || []);

    const result = await uploadInvoiceExcelExport({
      invoices,
      jobId,
      baseUrl: req.nextUrl.origin
    });

    // Tracking hook (additive — does not affect the export output): record that
    // each included invoice was exported. Best-effort; a failure here must never
    // fail the already-finished export, so it's logged, not thrown.
    const exportedIds = invoices.map((inv) => inv.id).filter(Boolean);
    if (exportedIds.length > 0) {
      const { error: trackError } = await supabaseAdmin.rpc("increment_invoice_exports", { p_ids: exportedIds });
      if (trackError) console.error("[export] export-count tracking failed:", trackError.message);
    }

    return result;
  }

  // ZIP: select file_key and convert to s3:// URI so signedReadUrl works correctly
  let query = supabaseAdmin.from("files").select("file_key");
  query = applyCommonFilters(query, filters, "created_at");
  const { data, error } = await query.order("created_at", { ascending: true }).limit(500);
  if (error) throw new Error(error.message);

  const bucket = env.s3Bucket || process.env.AWS_S3_BUCKET || "";
  const fileUrls = (data || []).map((row) => `s3://${bucket}/${row.file_key}`);
  return uploadZipExport({ fileUrls, jobId, baseUrl: req.nextUrl.origin });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return jsonError("Invalid export request", 400, parsed.error.flatten());

  const { data, error } = await supabaseAdmin
    .from("export_jobs")
    .insert({
      type: parsed.data.type,
      status: "processing",
      filters: {
        phone:     parsed.data.phone,
        from:      parsed.data.from,
        to:        parsed.data.to,
        client:    parsed.data.client,
        invoice:   parsed.data.invoice,
        direction: parsed.data.direction
      }
    })
    .select("id,status,type,created_at")
    .single();

  if (error) return jsonError(error.message, 500);

  if (!parsed.data.async_job) {
    try {
      const result = await runInlineExport(req, data.id, parsed.data);
      await supabaseAdmin
        .from("export_jobs")
        .update({
          status: "done",
          download_url: result.download_url,
          file_count: result.file_count,
          completed_at: new Date().toISOString()
        })
        .eq("id", data.id);

      return NextResponse.json({
        jobId: data.id,
        status: "done",
        type: data.type,
        download_url: result.download_url,
        file_count: result.file_count
      });
    } catch (inlineError) {
      const message = inlineError instanceof Error ? inlineError.message : "Export failed";
      await supabaseAdmin
        .from("export_jobs")
        .update({ status: "error", error: message, completed_at: new Date().toISOString() })
        .eq("id", data.id);
      return jsonError(message, 500);
    }
  }

  return NextResponse.json(
    {
      jobId: data.id,
      status: data.status,
      type: data.type,
      poll_url: `/api/export?jobId=${data.id}`
    },
    { status: 202 }
  );
}

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return jsonError("Missing jobId", 400);

  const { data, error } = await supabaseAdmin
    .from("export_jobs")
    .select("id,type,status,filters,download_url,file_count,error,created_at,completed_at")
    .eq("id", jobId)
    .single();

  if (error) return jsonError(error.message, error.code === "PGRST116" ? 404 : 500);
  return NextResponse.json(data);
}
