import { describe, expect, it } from 'vitest';
import { parseAmount } from './amount.js';

describe('parseAmount', () => {
  it('passes through bare integers and decimals', () => {
    expect(parseAmount('1234')).toEqual({ value: 1234, error: null });
    expect(parseAmount('1234.56')).toEqual({ value: 1234.56, error: null });
  });

  it('strips US currency formatting', () => {
    expect(parseAmount('$1,234.56')).toEqual({ value: 1234.56, error: null });
    expect(parseAmount('$45,000')).toEqual({ value: 45000, error: null });
  });

  it('handles EU-style comma decimals', () => {
    expect(parseAmount('1.234,56')).toEqual({ value: 1234.56, error: null });
  });

  it('treats parens as negative', () => {
    expect(parseAmount('(123.45)')).toEqual({ value: -123.45, error: null });
    expect(parseAmount('($1,234.56)')).toEqual({ value: -1234.56, error: null });
  });

  it('handles trailing currency code', () => {
    expect(parseAmount('1234.56 USD')).toEqual({ value: 1234.56, error: null });
  });

  it('returns null for blanks', () => {
    expect(parseAmount('')).toEqual({ value: null, error: null });
    expect(parseAmount('   ')).toEqual({ value: null, error: null });
    expect(parseAmount(null)).toEqual({ value: null, error: null });
  });

  it('reports an error for non-numeric input', () => {
    const r = parseAmount('not a number');
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/amount/);
  });
});
