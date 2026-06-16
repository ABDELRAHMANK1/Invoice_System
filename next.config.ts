import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pdfkit reads its built-in font metrics (*.afm) from disk at runtime; ensure
  // the serverless trace for the invoice route bundles that data folder.
  outputFileTracingIncludes: {
    "/api/invoices": ["./node_modules/pdfkit/js/data/**/*"]
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb"
    }
  }
};

export default nextConfig;
