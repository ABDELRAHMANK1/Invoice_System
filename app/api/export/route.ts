import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uploadInvoiceExcelExport, uploadZipExport } from "@/lib/export-builders";
import { jsonError, requireInternalApiKey } from "@/lib/http";
import { applyCommonFilters, filtersFromRequest } from "@/lib/query";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { env } from "@/lib/env";

export const runtime = "nodejs";

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
      .select("id,invoice_number,client_name,phone_number,date,total_amount,currency,file_url,created_at,status,raw_extraction,invoice_direction");
    if (body.ids && body.ids.length > 0) {
      query = query.in("id", body.ids);
    } else {
      query = applyCommonFilters(query, filters, "date");
    }
    const { data, error } = await query.order("created_at", { ascending: false }).limit(10000);
    if (error) throw new Error(error.message);

    return uploadInvoiceExcelExport({
      invoices: data || [],
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
