import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uploadInvoiceExcelExport, uploadZipExport, type InvoiceExportRow } from "@/lib/export-builders";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { env } from "@/lib/env";

export const runtime = "nodejs";

type SupplierRow = { client_id: string; name: string; relatie_code: string | null };

const SUPPLIER_STOPWORDS = new Set([
  "b.v.", "bv", "b.v", "n.v.", "nv", "v.o.f.", "vof", "cv",
  "de", "het", "den", "der",
  "en", "&", "+",
  "zn", "zonen", "gebr", "gebrs", "bros", "brothers",
  "the", "of", "and", "co", "co.", "ltd", "inc", "gmbh",
  "cash", "carry",
]);

function normaliseName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function significantTokens(value: string | null | undefined): string[] {
  return normaliseName(value)
    .replace(/[.,/\\()'"!?]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !SUPPLIER_STOPWORDS.has(t));
}

/**
 * Score how well a DB supplier name matches an invoice supplier_name.
 * Returns the count of significant token overlaps (case-insensitive),
 * with a small bonus when either side fully contains the other as a substring.
 * Zero = no match.
 */
function scoreMatch(supplierName: string, invoiceSupplier: string): number {
  const dbTokens  = new Set(significantTokens(supplierName));
  const invTokens = significantTokens(invoiceSupplier);
  if (dbTokens.size === 0 || invTokens.length === 0) return 0;

  let overlap = 0;
  for (const t of invTokens) if (dbTokens.has(t)) overlap += 1;

  const dbNorm  = normaliseName(supplierName);
  const invNorm = normaliseName(invoiceSupplier);
  const substringBonus = dbNorm.includes(invNorm) || invNorm.includes(dbNorm) ? 1 : 0;

  return overlap + substringBonus;
}

/**
 * Look up supplier.relatie_code (inkoop) or client.relatie_code (verkoop) per invoice,
 * matched on phone_number → client_id and a substring-based supplier-name fuzzy match.
 */
async function attachRelatieCodes(rows: InvoiceExportRow[]): Promise<InvoiceExportRow[]> {
  if (rows.length === 0) return rows;

  const phoneNumbers = Array.from(new Set(rows.map((r) => r.phone_number).filter(Boolean)));
  if (phoneNumbers.length === 0) return rows;

  const { data: clientRows, error: clientErr } = await supabaseAdmin
    .from("clients")
    .select("id,phone_number,relatie_code")
    .in("phone_number", phoneNumbers);
  if (clientErr || !clientRows) return rows;

  const phoneToClient = new Map<string, { id: string; relatie_code: string | null }>();
  for (const c of clientRows) {
    if (c.phone_number) phoneToClient.set(c.phone_number, { id: c.id, relatie_code: c.relatie_code ?? null });
  }
  const clientIds = Array.from(new Set(clientRows.map((c) => c.id)));
  if (clientIds.length === 0) return rows;

  const { data: supplierRows } = await supabaseAdmin
    .from("suppliers")
    .select("client_id,name,relatie_code")
    .in("client_id", clientIds);

  const suppliersByClient = new Map<string, SupplierRow[]>();
  for (const s of (supplierRows ?? []) as SupplierRow[]) {
    const list = suppliersByClient.get(s.client_id) ?? [];
    list.push(s);
    suppliersByClient.set(s.client_id, list);
  }

  return rows.map((row) => {
    const client = phoneToClient.get(row.phone_number);
    if (!client) return row;

    const direction = row.invoice_direction ?? "inkoop";

    if (direction === "verkoop") {
      return { ...row, relatie_code: client.relatie_code };
    }

    const candidates = suppliersByClient.get(client.id) ?? [];
    if (!row.supplier_name) {
      console.log(`[export.relatie] inv=${row.invoice_number} supplier_name=<empty> match=none`);
      return row;
    }

    let best: { supplier: SupplierRow; score: number } | null = null;
    for (const s of candidates) {
      const score = scoreMatch(s.name, row.supplier_name);
      if (score > 0 && (best === null || score > best.score)) {
        best = { supplier: s, score };
      }
    }

    if (!best) {
      console.log(`[export.relatie] inv=${row.invoice_number} supplier_name="${row.supplier_name}" match=NONE (candidates=${candidates.length})`);
      return row;
    }

    console.log(`[export.relatie] inv=${row.invoice_number} supplier_name="${row.supplier_name}" matched="${best.supplier.name}" code=${best.supplier.relatie_code ?? "<null>"} score=${best.score}`);
    return best.supplier.relatie_code ? { ...row, relatie_code: best.supplier.relatie_code } : row;
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
      .select("id,invoice_number,client_name,supplier_name,phone_number,date,total_amount,currency,file_url,created_at,status,raw_extraction,invoice_direction");
    if (body.ids && body.ids.length > 0) {
      query = query.in("id", body.ids);
    } else {
      query = applyCommonFilters(query, filters, "date");
    }
    const { data, error } = await query.order("created_at", { ascending: false }).limit(10000);
    if (error) throw new Error(error.message);

    const invoices = await attachRelatieCodes(data || []);

    return uploadInvoiceExcelExport({
      invoices,
      jobId,
      baseUrl: req.nextUrl.origin
    });
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
