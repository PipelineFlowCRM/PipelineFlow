import { describe, expect, it } from 'vitest';
import {
  formatToken,
  isValidScope,
  newTokenId,
  newTokenSecret,
  parseToken,
  tokenHasScope,
  tokenScopes,
} from './apiToken.js';

describe('parseToken', () => {
  it('round-trips formatToken', () => {
    const id = newTokenId();
    const secret = newTokenSecret();
    const wire = formatToken(id, secret);
    const parsed = parseToken(wire);
    expect(parsed).toEqual({ id, secret });
  });

  it('rejects tokens without the pf_ prefix', () => {
    expect(parseToken('tok_abc.secret')).toBeNull();
    expect(parseToken('Bearer pf_tok_abc.secret')).toBeNull();
  });

  it('rejects tokens with a wrong id segment', () => {
    expect(parseToken('pf_xxx_abc.secret')).toBeNull();
  });

  it('rejects tokens missing the secret half', () => {
    expect(parseToken('pf_tok_abc')).toBeNull();
  });

  it('handles base64url underscores in the secret', () => {
    // The wire format separates id and secret with `.` — neither
    // segment contains `.`, so even underscore-heavy base64url
    // contents round-trip cleanly.
    const id = 'tok_AAAA_BBBB';
    const secret = 'sec_with_extra_underscores';
    const wire = formatToken(id, secret);
    expect(parseToken(wire)).toEqual({ id, secret });
  });
});

describe('newTokenId / newTokenSecret', () => {
  it('produces distinct ids', () => {
    const a = newTokenId();
    const b = newTokenId();
    expect(a).not.toBe(b);
    expect(a.startsWith('tok_')).toBe(true);
  });

  it('produces sufficiently long secrets', () => {
    const s = newTokenSecret();
    // 32 bytes base64url-encoded is 43 chars (no padding).
    expect(s.length).toBeGreaterThanOrEqual(40);
  });
});

describe('scope helpers', () => {
  it('isValidScope accepts the catalog values', () => {
    expect(isValidScope('read')).toBe(true);
    expect(isValidScope('write')).toBe(true);
    expect(isValidScope('delete')).toBe(true);
    expect(isValidScope('admin')).toBe(false);
  });

  it('tokenScopes filters out garbage entries', () => {
    const fake = {
      // Mock just the surface tokenScopes inspects.
      scopes: ['read', 'write', 'admin', 42, null] as unknown,
    } as Parameters<typeof tokenScopes>[0];
    expect(tokenScopes(fake).sort()).toEqual(['read', 'write']);
  });

  it('tokenHasScope is true only for granted scopes', () => {
    const fake = { scopes: ['read'] } as unknown as Parameters<typeof tokenHasScope>[0];
    expect(tokenHasScope(fake, 'read')).toBe(true);
    expect(tokenHasScope(fake, 'write')).toBe(false);
    expect(tokenHasScope(fake, 'delete')).toBe(false);
  });
});
