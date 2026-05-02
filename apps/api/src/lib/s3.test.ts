import { describe, expect, it } from 'vitest';
import { dispositionHeader, obsoleteImageKey } from './s3.js';

// Pure function — no I/O, no fixtures. Each case maps a (oldRef, newRef)
// input to whether the cleanup queue should remove the old key.
describe('obsoleteImageKey', () => {
  it('returns null when there is no prior ref to clean up', () => {
    expect(obsoleteImageKey(null, 'avatar/2026-05-01/new.png')).toBeNull();
    expect(obsoleteImageKey('', 'avatar/2026-05-01/new.png')).toBeNull();
  });

  it('returns null when the ref is unchanged (no replacement happened)', () => {
    expect(
      obsoleteImageKey('avatar/2026-05-01/same.png', 'avatar/2026-05-01/same.png'),
    ).toBeNull();
  });

  it('returns null when the prior ref is an absolute http URL (not in our bucket)', () => {
    expect(
      obsoleteImageKey('https://gravatar.com/avatar/abc', 'avatar/2026-05-01/new.png'),
    ).toBeNull();
    expect(obsoleteImageKey('http://example.com/img.png', null)).toBeNull();
  });

  it('returns the prior key when an S3-key avatar is replaced with another', () => {
    expect(
      obsoleteImageKey('avatar/2026-04-01/old.png', 'avatar/2026-05-01/new.png'),
    ).toBe('avatar/2026-04-01/old.png');
  });

  it('returns the prior key when the avatar is cleared (replaced with null)', () => {
    expect(obsoleteImageKey('avatar/2026-04-01/old.png', null)).toBe(
      'avatar/2026-04-01/old.png',
    );
  });

  it('returns the prior key when an S3 key is replaced with an external URL', () => {
    expect(
      obsoleteImageKey('logo/2026-03-01/old.png', 'https://cdn.example.com/logo.png'),
    ).toBe('logo/2026-03-01/old.png');
  });
});

describe('dispositionHeader', () => {
  it('emits both ASCII and UTF-8 forms', () => {
    const h = dispositionHeader('report.pdf');
    expect(h).toContain('filename="report.pdf"');
    expect(h).toContain("filename*=UTF-8''report.pdf");
  });

  it('strips CR/LF so they cannot terminate the header', () => {
    const h = dispositionHeader('evil\r\nX-Pwn: 1');
    expect(h).not.toMatch(/[\r\n]/);
  });

  it('strips embedded quotes from the ASCII form', () => {
    const h = dispositionHeader('a"b.txt');
    const ascii = h.match(/filename="([^"]*)"/)![1];
    expect(ascii).not.toContain('"');
  });

  it('falls back to "download" when the name reduces to empty', () => {
    expect(dispositionHeader('   ')).toContain('filename="download"');
    expect(dispositionHeader('\r\n')).toContain('filename="download"');
  });

  it('percent-encodes non-ASCII in the filename* form', () => {
    const h = dispositionHeader('résumé.pdf');
    expect(h).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });
});
