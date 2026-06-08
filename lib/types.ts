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
