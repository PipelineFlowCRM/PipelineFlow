// Shared types for the per-entity validators. Each validator turns a raw
// CSV row + canonical-field mapping into a normalized record ready for
// upsert, alongside a list of per-cell errors. Errors do not throw —
// the row-runner collects them so good rows can still commit.

export interface ValidationError {
  row: number; // 1-indexed against the source CSV (row 1 = header line)
  column: string | null; // CSV header that produced the error
  value: string | null;
  reason: string;
}

export interface ValidatedRow<T> {
  data: T | null;
  errors: ValidationError[];
}
