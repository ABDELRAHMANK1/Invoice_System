import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep pdfkit unbundled: it reads its built-in font metrics (*.afm) from disk
  // relative to its own location in node_modules. If Next bundles it into a
  // vendor chunk, those .afm files aren't copied and rendering fails with
  // "ENOENT … data/Helvetica.afm". Marking it external loads it from node_modules.
  serverExternalPackages: ["pdfkit"],
  // And include the font data in the serverless deployment trace. These keys are
  // PER ROUTE, so every route that renders a PDF needs its own entry —
  // `serverExternalPackages` above is global, this is not.
  outputFileTracingIncludes: {
    "/api/invoices": ["./node_modules/pdfkit/js/data/**/*"],
    // Monthly Urenlijst (lib/timesheet-pdf.ts).
    "/api/clients/[id]/employees/[employeeId]/schedule/pdf": ["./node_modules/pdfkit/js/data/**/*"]
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb"
    }
  }
};

export default nextConfig;
