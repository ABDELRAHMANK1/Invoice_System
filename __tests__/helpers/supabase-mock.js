// Chainable Supabase query-builder mock.
//
// Every chainable method returns the same chain. The chain is thenable so
// `await query` resolves to { data, error, count }, just like the real client.
// Tests inspect `_calls` to verify what methods were chained and with which
// arguments, and call `_setResult` to control the resolved value.
//
// Plain JS so it can be `require()`d from vi.hoisted blocks without needing
// the TypeScript / @-alias resolver.

// Vitest's `vi` is passed in by the caller so this helper can be required from
// a `vi.hoisted` block (vitest itself cannot be required, only imported).

function makeChain(vi, initial) {
  const result = { ...initial };
  const calls = [];
  const chain = {
    _calls: calls,
    _setResult(next) {
      Object.assign(result, next);
    },
    _reset() {
      calls.length = 0;
      Object.assign(result, { data: null, error: null, count: 0 });
    },
    then(resolve) {
      return Promise.resolve(result).then(resolve);
    },
  };

  const chainable = [
    "select", "eq", "ilike", "gte", "lte", "in", "or", "not",
    "order", "range", "limit", "single", "maybeSingle",
    "insert", "update", "delete", "upsert",
  ];

  for (const method of chainable) {
    chain[method] = vi.fn((...args) => {
      calls.push({ method, args });
      return chain;
    });
  }

  return chain;
}

function makeSupabaseAdmin(vi) {
  const tables = new Map();
  const ensure = (name) => {
    if (!tables.has(name)) tables.set(name, makeChain(vi, { data: null, error: null, count: 0 }));
    return tables.get(name);
  };
  return {
    from: vi.fn((table) => ensure(table)),
    // Postgres function calls (supabaseAdmin.rpc). Resolves like a real call to
    // { data, error }; tests can inspect .rpc.mock.calls or override via
    // mockResolvedValueOnce.
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    _table: ensure,
    _resetAll() {
      for (const chain of tables.values()) chain._reset();
    },
  };
}

module.exports = { makeChain, makeSupabaseAdmin };
