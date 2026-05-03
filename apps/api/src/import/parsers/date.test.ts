import { describe, expect, it } from 'vitest';
import { parseDate, parseDatetime } from './date.js';

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

describe('parseDatetime', () => {
  it('preserves the time component for Pipedrive-style timestamps', () => {
    const r = parseDatetime('2013-12-16 20:32:02');
    expect(r.error).toBeNull();
    expect(r.value).toBe('2013-12-16T20:32:02.000Z');
  });

  it('round-trips losslessly through new Date()', () => {
    const r = parseDatetime('2013-12-16 20:32:02');
    const back = new Date(r.value!);
    expect(back.toISOString()).toBe('2013-12-16T20:32:02.000Z');
  });

  it('keeps two same-day timestamps distinct (the regression case)', () => {
    // The whole reason parseDatetime exists: multiple notes from the
    // same Pipedrive day need to keep their relative ordering on the
    // deal timeline, not collapse to identical midnight values.
    const a = parseDatetime('2013-12-16 20:32:02').value;
    const b = parseDatetime('2013-12-16 21:00:00').value;
    const c = parseDatetime('2013-12-16 22:30:00').value;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(new Date(a!).getTime()).toBeLessThan(new Date(b!).getTime());
    expect(new Date(b!).getTime()).toBeLessThan(new Date(c!).getTime());
  });

  it('returns null for blank input without error', () => {
    expect(parseDatetime('')).toEqual({ value: null, error: null });
    expect(parseDatetime(null)).toEqual({ value: null, error: null });
  });

  it('reports an error for unparseable input', () => {
    const r = parseDatetime('not a datetime');
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/datetime/);
  });
});
