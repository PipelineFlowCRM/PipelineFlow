import { describe, expect, it } from 'vitest';
import { parseDate } from './date.js';

describe('parseDate', () => {
  it('passes through ISO dates', () => {
    expect(parseDate('2026-03-15')).toEqual({ value: '2026-03-15', error: null });
  });

  it('parses short US slash dates', () => {
    expect(parseDate('3/15/26').value).toBe('2026-03-15');
    expect(parseDate('03/15/2026').value).toBe('2026-03-15');
  });

  it('parses written-out dates', () => {
    expect(parseDate('March 15, 2026').value).toBe('2026-03-15');
  });

  it('returns null for blank input without error', () => {
    expect(parseDate('')).toEqual({ value: null, error: null });
    expect(parseDate(null)).toEqual({ value: null, error: null });
  });

  it('reports an error for unparseable input', () => {
    const r = parseDate('not a date');
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/date/);
  });
});
