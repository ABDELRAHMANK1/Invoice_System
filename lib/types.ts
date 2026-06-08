export type FileStatus = "pending" | "processing" | "done" | "error";
export type ExportType = "excel" | "zip";
export type ExportStatus = "pending" | "processing" | "done" | "error";
export type InvoiceDirection = "inkoop" | "verkoop";

export type ExtractedInvoice = {
  client_name: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  date: string | null;
  total_amount: number | null;
  currency?: string | null;
  vat_rate?: number | null;
  transaction_type?: "inkoop" | "verkoop" | null;
  confidence?: number | null;
};
