// Type declarations for the JS Supabase mock helper.
// Plain JS at runtime so it can be required from vi.hoisted blocks; this file
// gives test code real types without TS implicit-any errors.

export type SupabaseCall = { method: string; args: unknown[] };

export type SupabaseResult<T = unknown> = {
  data: T | null;
  error: { message: string } | null;
  count?: number | null;
};

export interface SupabaseChain {
  _calls: SupabaseCall[];
  _setResult<T>(next: SupabaseResult<T>): void;
  _reset(): void;
  select:  (...args: unknown[]) => SupabaseChain;
  eq:      (...args: unknown[]) => SupabaseChain;
  ilike:   (...args: unknown[]) => SupabaseChain;
  gte:     (...args: unknown[]) => SupabaseChain;
  lte:     (...args: unknown[]) => SupabaseChain;
  in:      (...args: unknown[]) => SupabaseChain;
  or:      (...args: unknown[]) => SupabaseChain;
  order:   (...args: unknown[]) => SupabaseChain;
  range:   (...args: unknown[]) => SupabaseChain;
  limit:   (...args: unknown[]) => SupabaseChain;
  single:  (...args: unknown[]) => SupabaseChain;
  insert:  (...args: unknown[]) => SupabaseChain;
  update:  (...args: unknown[]) => SupabaseChain;
  delete:  (...args: unknown[]) => SupabaseChain;
  upsert:  (...args: unknown[]) => SupabaseChain;
}

export interface SupabaseAdminMock {
  from(table: string): SupabaseChain;
  _table(name: string): SupabaseChain;
  _resetAll(): void;
}

export function makeChain<T = unknown>(vi: unknown, initial: SupabaseResult<T>): SupabaseChain;
export function makeSupabaseAdmin(vi: unknown): SupabaseAdminMock;
