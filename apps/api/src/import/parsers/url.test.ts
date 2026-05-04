import { describe, expect, it } from 'vitest';
import { parseUrl } from './url.js';

describe('parseUrl', () => {
  it('prepends https:// to bare domains', () => {
    expect(parseUrl('acme.com').value).toBe('https://acme.com');
  });

  it('keeps existing schemes intact', () => {
    expect(parseUrl('http://example.com').value).toBe('http://example.com');
    expect(parseUrl('https://example.com/path').value).toBe('https://example.com/path');
  });

  it('strips trailing slash', () => {
    expect(parseUrl('https://acme.com/').value).toBe('https://acme.com');
  });

  it('returns null for blanks', () => {
    expect(parseUrl('').value).toBeNull();
    expect(parseUrl(null).value).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(parseUrl('ftp://files.example.com').error).toMatch(/http/);
  });
});
