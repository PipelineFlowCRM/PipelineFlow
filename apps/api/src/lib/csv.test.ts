import { describe, expect, it } from 'vitest';
import { csvEscape, csvNeutralize } from './csv.js';

describe('csvNeutralize', () => {
  it('passes ordinary strings through', () => {
    expect(csvNeutralize('Acme Corp')).toBe('Acme Corp');
    expect(csvNeutralize('45,000.00')).toBe('45,000.00');
    expect(csvNeutralize('')).toBe('');
  });

  it.each(['=', '+', '-', '@', '\t', '\r', '\n'])(
    'prefixes leading %j with an apostrophe',
    (lead) => {
      const out = csvNeutralize(`${lead}HYPERLINK("evil")`);
      expect(out.startsWith("'")).toBe(true);
      expect(out).toBe(`'${lead}HYPERLINK("evil")`);
    },
  );

  it('only checks the first char', () => {
    expect(csvNeutralize('foo=bar')).toBe('foo=bar');
    expect(csvNeutralize('a-b')).toBe('a-b');
  });
});

describe('csvEscape', () => {
  it('quotes and escapes inner quotes', () => {
    expect(csvEscape('hello "world"')).toBe('"hello ""world"""');
  });

  it('combines neutralization with quoting', () => {
    expect(csvEscape('=cmd')).toBe(`"'=cmd"`);
  });
});
