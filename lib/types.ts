export type FileStatus = "pending" | "processing" | "done" | "error";
export type ExportType = "excel" | "zip";
export type ExportStatus = "pending" | "processing" | "done" | "error";
export type InvoiceDirection = "inkoop" | "verkoop";

export interface VatBreakdown {
  net_21: number;
  vat_21: number;
  net_9: number;
  vat_9: number;
  net_0: number;
  emballage: number;
}

export type ExtractedInvoice = {
  client_name: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  date: string | null;
  total_amount: number | null;
  currency?: string | null;
  vat_rate?: number | null;
  vat_breakdown?: VatBreakdown | null;
  transaction_type?: "inkoop" | "verkoop" | null;
  confidence?: number | null;
};

export interface Supplier {
  id: string;
  client_id: string;
  name: string;
  relatie_code: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  kvk: string | null;
  btw_number: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  payment_days: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// A client's customers (Klanten) — the parties it SELLS to. The `customers`
// table mirrors `suppliers` column-for-column (see migration 005), so the
// shape is identical; kept as a distinct type for call-site clarity.
export type Customer = Supplier;
