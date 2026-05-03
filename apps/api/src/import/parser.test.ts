import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv } from './parser.js';

describe('detectDelimiter', () => {
  it('picks comma for US-style CSV', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('picks semicolon for EU-style CSV', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('picks tab for TSV', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('ignores delimiter chars inside quoted fields', () => {
    // The first non-quoted "real" delimiter is the comma after the closing
    // quote — semicolons inside the quoted cell shouldn't influence detection.
    expect(detectDelimiter('"hello;world",b,c\n')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('parses a simple CSV with quoted commas', () => {
    const text = 'name,notes\n"Acme, Inc.","hello, world"\n';
    const r = parseCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual(['name', 'notes']);
    expect(r.rows).toEqual([{ name: 'Acme, Inc.', notes: 'hello, world' }]);
  });

  it('strips a leading UTF-8 BOM', () => {
    const text = '﻿name,email\nJane,jane@example.com\n';
    const r = parseCsv(text);
    expect(r.headers[0]).toBe('name');
  });

  it('handles \\r\\n line endings', () => {
    const text = 'a,b\r\n1,2\r\n3,4\r\n';
    const r = parseCsv(text);
    expect(r.rows.length).toBe(2);
  });

  it('handles quoted newlines inside cells', () => {
    const text = 'a,b\n"line\n1",2\n';
    const r = parseCsv(text);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.a).toBe('line\n1');
  });
});
