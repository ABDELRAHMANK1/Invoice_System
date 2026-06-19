// Fuzzy relatie-name matcher — shared by the Excel export route (matching an
// invoice's counterparty name against the client's suppliers/customers to
// resolve a Snelstart Relatiecode) and the standalone Snelstart import
// converter script. Token-overlap with Levenshtein tolerance so minor
// OCR/extraction typos still match (e.g. "Alaseel" vs DB "Alseel").
//
// Extracted verbatim from app/api/export/route.ts so both call sites share one
// implementation — do not fork the logic.

const STOPWORDS = new Set([
  "b.v.", "bv", "b.v", "n.v.", "nv", "v.o.f.", "vof", "cv",
  "de", "het", "den", "der",
  "en", "&", "+",
  "zn", "zonen", "gebr", "gebrs", "bros", "brothers",
  "the", "of", "and", "co", "co.", "ltd", "inc", "gmbh",
  "cash", "carry",
]);

export function normaliseName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function significantTokens(value: string | null | undefined): string[] {
  return normaliseName(value)
    .replace(/[.,/\\()'"!?]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Levenshtein edit distance between two strings.
 * Used to forgive minor OCR/extraction typos in name matching
 * (e.g. AI reads "Alaseel" when the DB has "Alseel" — one insertion).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Two tokens are "similar" when they are either equal or within a small edit
 * distance, where the tolerated distance scales with token length so that
 * short tokens stay strict (avoids matching "BV" to "BB") but longer names
 * can absorb one or two character OCR mistakes.
 */
export function tokenSimilar(t1: string, t2: string): boolean {
  if (t1 === t2) return true;
  const minLen = Math.min(t1.length, t2.length);
  if (minLen < 4) return false;
  const allowed = minLen >= 8 ? 2 : 1;
  return levenshtein(t1, t2) <= allowed;
}

/**
 * Score how well a DB relation name matches an invoice counterparty name.
 * Counts overlapping significant tokens (with edit-distance tolerance), plus
 * a small bonus when either normalised name fully contains the other as a
 * substring. Zero = no match.
 */
export function scoreMatch(dbName: string, invoiceName: string): number {
  const dbTokens  = significantTokens(dbName);
  const invTokens = significantTokens(invoiceName);
  if (dbTokens.length === 0 || invTokens.length === 0) return 0;

  let overlap = 0;
  for (const t of invTokens) {
    if (dbTokens.some((db) => tokenSimilar(db, t))) overlap += 1;
  }

  const dbNorm  = normaliseName(dbName);
  const invNorm = normaliseName(invoiceName);
  const substringBonus = dbNorm.includes(invNorm) || invNorm.includes(dbNorm) ? 1 : 0;

  return overlap + substringBonus;
}

/**
 * Pick the best-scoring candidate name from a list. Returns the matched
 * candidate + score, or null when nothing scores above zero. Generic over the
 * candidate shape so callers can carry their own row alongside the name.
 */
export function bestNameMatch<T>(
  candidates: T[],
  getName: (c: T) => string,
  invoiceName: string,
): { match: T; score: number } | null {
  let best: { match: T; score: number } | null = null;
  for (const c of candidates) {
    const score = scoreMatch(getName(c), invoiceName);
    if (score > 0 && (best === null || score > best.score)) {
      best = { match: c, score };
    }
  }
  return best;
}
