import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireInternalApiKey } from "@/lib/http";

// ── GET /api/files/url?key=<file_key>&expires=<seconds> ───────────────────
//
//  Generates a short-lived signed URL for any private S3 object.
//
//  Input formats accepted for `key`:
//    • Plain S3 key:    "whatsapp-invoices/201012345678/2026/04/13/file.pdf"
//    • s3:// URI:       "s3://my-bucket/whatsapp-invoices/.../file.pdf"
//    • Full S3 HTTPS:   "https://my-bucket.s3.eu-west-1.amazonaws.com/..."
//      (the https form is stripped down to key only — bucket from env)
//
//  Returns:
//    { url: "https://my-bucket.s3.amazonaws.com/...?X-Amz-Signature=..." }
//
//  The signed URL expires in `expires` seconds (default 300, max 86400).
//
//  This endpoint is called by:
//    • The dashboard when a user clicks a file to preview/download.
//    • lib/ai-extraction.ts before sending file URLs to the AI model.
//    • Export jobs when building ZIP download links.
//
const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET!;

function extractKey(raw: string): string {
  // s3://bucket/key  →  key
  if (raw.startsWith("s3://")) {
    const withoutScheme = raw.slice(5);               // "bucket/key/..."
    const slashIdx = withoutScheme.indexOf("/");
    return slashIdx === -1 ? withoutScheme : withoutScheme.slice(slashIdx + 1);
  }

  // https://bucket.s3.region.amazonaws.com/key  →  key
  if (raw.startsWith("https://") && raw.includes(".amazonaws.com/")) {
    const afterHost = raw.split(".amazonaws.com/")[1] ?? "";
    // strip query string (old signed URL passed in by mistake)
    return afterHost.split("?")[0];
  }

  // plain key — strip any leading slash
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

export async function GET(req: NextRequest) {
  const authError = requireInternalApiKey(req);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const raw     = searchParams.get("key");
    const expires = Math.min(
      86400,
      Math.max(60, parseInt(searchParams.get("expires") || "300", 10))
    );

    if (!raw || raw.trim() === "") {
      return NextResponse.json({ error: "Missing key parameter" }, { status: 400 });
    }

    const key = extractKey(raw.trim());

    if (!key) {
      return NextResponse.json({ error: "Could not parse S3 key from input" }, { status: 400 });
    }

    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url     = await getSignedUrl(s3, command, { expiresIn: expires });

    return NextResponse.json({ url, key, expires_in: expires });
  } catch (err) {
    console.error("[GET /api/files/url] Error:", err);
    return NextResponse.json({ error: "Failed to generate signed URL" }, { status: 500 });
  }
}
