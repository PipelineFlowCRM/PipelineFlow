// Parser for the `amount` column. Accepts the messiest forms a CSV ever
// emits: `$1,234.56`, `(123.45)` (negative parens), `1.234,56` (EU style),
// trailing currency code "1234.56 USD", whitespace and blanks. Returns
// `null` on empty input so the caller can decide whether that's an error
// (Deal.amount is not required — it defaults to 0).
//
// Returns `{ value, error }` rather than throwing because the import path
// collects errors row-by-row; throwing would short-circuit the import.
export function parseAmount(input: string | null | undefined): {
  value: number | null;
  error: string | null;
} {
  if (input == null) return { value: null, error: null };
  let s = String(input).trim();
  if (s === '') return { value: null, error: null };

  // (123.45) → -123.45 — accountant-style negative.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }

  // Strip currency symbols and ISO codes. `\p{Sc}` covers $, €, £, ¥, etc.
  s = s.replace(/^[\p{Sc}]+/u, '').trim();
  s = s.replace(/[A-Za-z]+$/u, '').trim();
  s = s.replace(/^[A-Za-z]+/u, '').trim();

  if (s === '') return { value: null, error: 'amount: missing numeric value' };

  // Decide between US (1,234.56) and EU (1.234,56) by which separator
  // appears last. If both appear, the rightmost is the decimal separator.
  // If only one appears and there's exactly one of it followed by 1-2
  // digits, treat it as a decimal point regardless of locale.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized = s;
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) {
      // EU: drop dots (thousands), comma is decimal
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: drop commas (thousands), dot is decimal
      normalized = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0 && lastDot < 0) {
    // Only comma. If looks like a thousands separator (3 digits after) drop it; else treat as decimal.
    const after = s.slice(lastComma + 1);
    if (/^\d{3}$/.test(after) && /^\d{1,3}(,\d{3})+$/.test(s)) {
      normalized = s.replace(/,/g, '');
    } else {
      normalized = s.replace(',', '.');
    }
  } else if (lastDot >= 0 && lastComma < 0) {
    const after = s.slice(lastDot + 1);
    // "1.234" with three trailing digits could be EU thousands. We only
    // collapse it if there are multiple dots; one dot stays as a decimal.
    if ((s.match(/\./g) ?? []).length > 1) {
      normalized = s.replace(/\./g, '');
    }
  }

  // Strip any remaining non-numeric junk except the leading sign and decimal point
  normalized = normalized.replace(/[^\d.]/g, '');
  if (normalized === '' || normalized === '.') {
    return { value: null, error: `amount: not a number ("${input}")` };
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) {
    return { value: null, error: `amount: not a number ("${input}")` };
  }
  return { value: negative ? -n : n, error: null };
}
