import * as chrono from 'chrono-node';

// Forgiving parser for date cells in CSV. Accepts ISO ("2026-03-15"),
// US slashes ("3/15/26"), word forms ("March 15, 2026"), and most other
// human-typed forms via chrono. Returns a YYYY-MM-DD string for storage
// in `@db.Date` columns — Prisma accepts this directly.
//
// For ambiguous numeric forms like "3/4/26" we use forwardDate=false and
// US locale (chrono's default) — the spec target is US-export CSVs and
// keeping this consistent matters more than supporting every locale. If
// future Pipedrive locales need MDY/DMY toggling, the strict-mode
// parsers in chrono.en / chrono.de live here.
export function parseDate(input: string | null | undefined): {
  value: string | null;
  error: string | null;
} {
  if (input == null) return { value: null, error: null };
  const s = String(input).trim();
  if (s === '') return { value: null, error: null };

  // Fast path: already in YYYY-MM-DD form. Avoids the chrono cost on
  // exports that already speak ISO (Pipedrive CSVs do).
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { value: s, error: null };
  }

  const parsed = chrono.parseDate(s);
  if (!parsed) {
    return { value: null, error: `date: could not parse "${input}"` };
  }
  // ISO date in UTC slice — Date columns ignore the time portion.
  // Use UTC to keep the day from drifting when the server clock is in
  // a non-UTC zone (a "3/15/26" parsed at midnight local would otherwise
  // shift to the previous day after toISOString).
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getUTCDate()).padStart(2, '0');
  return { value: `${yyyy}-${mm}-${dd}`, error: null };
}
