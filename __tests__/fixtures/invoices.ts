import type { InvoiceExportRow } from "@/lib/export-builders";

export const sampleInvoiceInkoop21: InvoiceExportRow = {
  id: "11111111-1111-1111-1111-111111111111",
  invoice_number: "INV-0001",
  client_name: "Nema Food B.V.",
  phone_number: "+31612345678",
  date: "2026-05-10",
  total_amount: 121,
  currency: "EUR",
  file_url: "s3://test-bucket/files/2026/05/inv-0001.pdf",
  status: "extracted",
  created_at: "2026-05-10T08:30:00Z",
  invoice_direction: "inkoop",
  raw_extraction: { vat_rate: 21, transaction_type: "inkoop" },
};

export const sampleInvoiceInkoop9: InvoiceExportRow = {
  ...sampleInvoiceInkoop21,
  id: "22222222-2222-2222-2222-222222222222",
  invoice_number: "INV-0002",
  total_amount: 109,
  raw_extraction: { vat_rate: 9 },
};

export const sampleInvoiceInkoop0: InvoiceExportRow = {
  ...sampleInvoiceInkoop21,
  id: "33333333-3333-3333-3333-333333333333",
  invoice_number: "INV-0003",
  total_amount: 100,
  raw_extraction: { vat_rate: 0 },
};

export const sampleInvoiceVerkoop21: InvoiceExportRow = {
  ...sampleInvoiceInkoop21,
  id: "44444444-4444-4444-4444-444444444444",
  invoice_number: "INV-V-0001",
  client_name: "RAJEH FOOD",
  total_amount: 242,
  invoice_direction: "verkoop",
  raw_extraction: { vat_rate: 21, transaction_type: "verkoop" },
};

export const sampleInvoiceVerkoop9: InvoiceExportRow = {
  ...sampleInvoiceVerkoop21,
  id: "55555555-5555-5555-5555-555555555555",
  invoice_number: "INV-V-0002",
  total_amount: 109,
  raw_extraction: { vat_rate: 9 },
};

export const sampleInvoiceVerkoop0: InvoiceExportRow = {
  ...sampleInvoiceVerkoop21,
  id: "66666666-6666-6666-6666-666666666666",
  invoice_number: "INV-V-0003",
  total_amount: 100,
  raw_extraction: { vat_rate: 0 },
};

export const sampleApiInvoiceRow = {
  id: "11111111-1111-1111-1111-111111111111",
  file_id: "aaaaaaaa-1111-1111-1111-111111111111",
  phone_number: "+31612345678",
  invoice_number: "INV-0001",
  client_name: "Nema Food B.V.",
  date: "2026-05-10",
  total_amount: 121,
  currency: "EUR",
  file_url: "s3://test-bucket/files/2026/05/inv-0001.pdf",
  status: "extracted",
  confidence: 0.94,
  created_at: "2026-05-10T08:30:00Z",
  invoice_direction: "inkoop" as const,
};
