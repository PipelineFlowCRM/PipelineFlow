import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeIssuedKey, rememberIssuedKey } from './issuedKeys.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('issuedKeys', () => {
  it('accepts a key once, then rejects', () => {
    rememberIssuedKey('attachment/2026-04-30/abc-x.pdf');
    expect(consumeIssuedKey('attachment/2026-04-30/abc-x.pdf')).toBe(true);
    expect(consumeIssuedKey('attachment/2026-04-30/abc-x.pdf')).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(consumeIssuedKey('attachment/2026-04-30/never-issued.pdf')).toBe(false);
  });

  it('expires entries after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T00:00:00Z'));
    rememberIssuedKey('attachment/2026-04-30/expires.pdf');
    vi.advanceTimersByTime(7 * 60_000); // 7 min > 6 min TTL
    expect(consumeIssuedKey('attachment/2026-04-30/expires.pdf')).toBe(false);
  });
});
