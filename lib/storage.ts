import crypto from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

export const s3 = new S3Client({
  region: env.awsRegion || env.required("AWS_REGION"),
  credentials: {
    accessKeyId: env.awsAccessKeyId || env.required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: env.awsSecretAccessKey || env.required("AWS_SECRET_ACCESS_KEY")
  }
});

export function safePhonePath(phoneNumber: string) {
  return phoneNumber.replace(/[^\d+]/g, "").replace(/^\+/, "");
}

export function extensionFromType(fileType: string, mimeType?: string | null) {
  if (fileType === "pdf" || mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

export function s3PublicStyleUrl(key: string) {
  return `s3://${env.s3Bucket || env.required("AWS_S3_BUCKET")}/${key}`;
}

export function keyFromS3Url(fileUrl: string) {
  if (fileUrl.startsWith("s3://")) {
    const withoutProtocol = fileUrl.slice(5);
    const slash = withoutProtocol.indexOf("/");
    return withoutProtocol.slice(slash + 1);
  }

  if (!fileUrl.startsWith("http://") && !fileUrl.startsWith("https://")) {
    return fileUrl.replace(/^\/+/, "");
  }

  const url = new URL(fileUrl);
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

export async function uploadBuffer(params: {
  key: string;
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}) {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.s3Bucket || env.required("AWS_S3_BUCKET"),
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      Metadata: params.metadata
    })
  );

  return s3PublicStyleUrl(params.key);
}

export async function signedReadUrl(
  fileUrl: string,
  expiresIn = 60 * 60,
  opts?: { downloadName?: string; inline?: boolean }
) {
  const key = keyFromS3Url(fileUrl);
  // Override the response headers on the signed URL so the browser uses a
  // friendly filename and the right inline/attachment behaviour.
  let disposition: string | undefined;
  if (opts?.downloadName) {
    const safe = opts.downloadName.replace(/[\r\n"\\]/g, "").replace(/[^\w.\- ]/g, "_").slice(0, 120);
    disposition = `${opts.inline ? "inline" : "attachment"}; filename="${safe}"`;
  } else if (opts?.inline) {
    disposition = "inline";
  }
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.s3Bucket || env.required("AWS_S3_BUCKET"),
      Key: key,
      ...(disposition ? { ResponseContentDisposition: disposition } : {}),
    }),
    { expiresIn }
  );
}

export function buildInvoiceObjectKey(params: {
  phoneNumber: string;
  fileType: string;
  mimeType?: string | null;
  originalName?: string | null;
}) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const ext = extensionFromType(params.fileType, params.mimeType);
  const hash = crypto.randomUUID();
  const cleanOriginal = params.originalName?.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  const suffix = cleanOriginal ? `${hash}-${cleanOriginal}` : `${hash}.${ext}`;

  return `whatsapp-invoices/${safePhonePath(params.phoneNumber)}/${yyyy}/${mm}/${dd}/${suffix}`;
}

export function buildExportObjectKey(type: "excel" | "zip", jobId: string) {
  const ext = type === "excel" ? "xlsx" : "zip";
  return `exports/${type}/${new Date().toISOString().slice(0, 10)}/${jobId}.${ext}`;
}
