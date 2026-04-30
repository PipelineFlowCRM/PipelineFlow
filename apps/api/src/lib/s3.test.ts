import { describe, expect, it } from 'vitest';
import { dispositionHeader } from './s3.js';

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
