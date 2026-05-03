import { describe, expect, it } from 'vitest';
import { parsePhone } from './phone.js';

describe('parsePhone', () => {
  it('formats valid US numbers to international form', () => {
    expect(parsePhone('(415) 555-1234')).toBe('+1 415 555 1234');
    expect(parsePhone('4155551234')).toBe('+1 415 555 1234');
  });

  it('keeps already-international numbers', () => {
    expect(parsePhone('+44 20 7946 0958')?.startsWith('+44')).toBe(true);
  });

  it('returns null for blanks', () => {
    expect(parsePhone('')).toBeNull();
    expect(parsePhone(null)).toBeNull();
  });

  it('keeps unparseable values verbatim', () => {
    // E.g. an extension or a non-phone string — better to keep something
    // searchable than drop the cell on the floor.
    expect(parsePhone('not a phone')).toBe('not a phone');
  });
});
