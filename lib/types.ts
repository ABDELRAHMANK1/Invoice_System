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

/** How a customer is billed — drives the meaning of `default_rate`. */
export const PRICING_MODELS = ["hourly", "per_stop", "lump_sum"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

/** The BTW rates modelled everywhere in this codebase (Dutch rates only). */
export const BTW_RATES = [21, 9, 0] as const;

/**
 * Customer-only columns — the invoicing settings that don't exist on
 * `suppliers`. Kept separate so the shared counterparty modal can type them as
 * optional on a supplier record.
 */
export interface CustomerExtras {
  btw_rate: number;
  btw_verlegd: boolean;
  pricing_model: PricingModel;
  default_rate: number | null;
  aliases: string[] | null;
  message_pattern: string | null;
}

// A client's customers (Klanten) — the parties it SELLS to. The `customers`
// table started as a column-for-column mirror of `suppliers` (migration 005)
// and has since grown its own invoicing settings (see CustomerExtras).
export interface Customer extends Supplier, CustomerExtras {}
