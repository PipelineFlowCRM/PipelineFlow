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
  // Use *local* getters so the returned date is the one the user sees
  // in their CSV cell. chrono parses inputs without an explicit tz at
  // local midnight; using `getUTCDate()` on that flips the day to the
  // next when the server runs in a Western tz (e.g. EST: midnight local
  // = 5:00 UTC = same day; but a row like "2013-12-16 20:32:02" parsed
  // local = 8:32 PM EST = 1:32 AM UTC the next day → wrong day).
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  return { value: `${yyyy}-${mm}-${dd}`, error: null };
}

// Same forgiving parsing as parseDate, but preserves the time component
// for storage in `DateTime` columns. Used by the Notes import: a single
// Pipedrive `Add time` like "2013-12-16 20:32:02" needs to round-trip
// to a millisecond-precise timestamp so multiple notes from the same
// day keep their relative ordering on the deal timeline.
//
// Output is an ISO-8601 string in UTC. chrono's local-midnight default
// for tz-less inputs is preserved here on purpose — the user typed a
// wall-clock time, we shouldn't shift it. Constructing the Date from
// the parsed components in UTC gives us a stable timestamp that
// `new Date(value)` round-trips losslessly into Prisma.
export function parseDatetime(input: string | null | undefined): {
  value: string | null;
  error: string | null;
} {
  if (input == null) return { value: null, error: null };
  const s = String(input).trim();
  if (s === '') return { value: null, error: null };

  const parsed = chrono.parseDate(s);
  if (!parsed) {
    return { value: null, error: `datetime: could not parse "${input}"` };
  }
  // Re-anchor the local-time components into UTC. chrono returns a Date
  // anchored at *local* time when the input has no explicit tz — that's
  // what the user typed, but Date.toISOString() would shift it. We
  // re-construct the Date with the same wall-clock components in UTC so
  // the stored timestamp matches what's in the cell, regardless of the
  // server's timezone.
  const isoUtc = new Date(
    Date.UTC(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate(),
      parsed.getHours(),
      parsed.getMinutes(),
      parsed.getSeconds(),
    ),
  ).toISOString();
  return { value: isoUtc, error: null };
}
