import { parse } from 'csv-parse/sync';

// Stripping a leading UTF-8 BOM keeps the first header from coming back as
// "﻿Person - Name" — a real bite when matching against synonyms.
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Sample the first non-empty line — outside of quotes — to pick the
// delimiter. Falls back to comma when the sample is too thin to decide.
// We only ever need a 1-of-3 decision so a heuristic count is plenty;
// csv-parse's auto-detect was pulled from sync mode, so we do this here.
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  let firstLine = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && (ch === '\n' || ch === '\r')) break;
    firstLine += ch;
  }
  const counts = {
    ',': (firstLine.match(/,/g) ?? []).length,
    ';': (firstLine.match(/;/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
  };
  let best: ',' | ';' | '\t' = ',';
  let bestCount = counts[','];
  if (counts[';'] > bestCount) {
    best = ';';
    bestCount = counts[';'];
  }
  if (counts['\t'] > bestCount) {
    best = '\t';
  }
  return best;
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: ',' | ';' | '\t';
}

export interface ParseError {
  row: number;
  column: string | null;
  reason: string;
}

export interface ParseResult extends ParsedCsv {
  errors: ParseError[];
}

// Parse a full CSV in memory. Capped at 50k rows / 10MB upstream — anything
// past that should split or fail before reaching this function. Returning a
// header[] alongside rows[] avoids re-deriving the column order from the
// first row's keys (which would otherwise depend on insertion order).
export function parseCsv(text: string): ParseResult {
  const cleaned = stripBom(text);
  const delimiter = detectDelimiter(cleaned);
  const errors: ParseError[] = [];
  // `relax_column_count: true` lets a row with too few columns through
  // (unmapped values become undefined). The route layer surfaces this
  // count in the validation summary so the user is not surprised.
  let records: Record<string, string>[] = [];
  let headers: string[] = [];
  try {
    records = parse(cleaned, {
      columns: (h: string[]) => {
        headers = h.map((x) => x.trim());
        return headers;
      },
      delimiter,
      bom: false, // we already stripped it
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: false,
    }) as Record<string, string>[];
  } catch (err) {
    const e = err as { message?: string; lines?: number };
    errors.push({
      row: e.lines ?? 0,
      column: null,
      reason: `Could not parse CSV: ${e.message ?? 'unknown error'}`,
    });
    return { headers, rows: [], delimiter, errors };
  }
  return { headers, rows: records, delimiter, errors };
}

// First N rows for the UI preview step. Defensive copy — the wizard mutates
// these client-side for redaction toggles in P1.
export function previewRows(parsed: ParsedCsv, n = 5): Record<string, string>[] {
  return parsed.rows.slice(0, n).map((r) => ({ ...r }));
}
