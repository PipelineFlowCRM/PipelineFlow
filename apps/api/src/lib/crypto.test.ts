import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateEncryptionKey } from './crypto.js';

describe('crypto', () => {
  it('round-trips plaintext', () => {
    const key = generateEncryptionKey();
    const plain = 'gha-refresh-token-1234567890';
    const wrapped = encryptSecret(plain, key);
    expect(wrapped).not.toContain(plain);
    expect(wrapped.startsWith('v1:')).toBe(true);
    expect(decryptSecret(wrapped, key)).toBe(plain);
  });

  it('produces a different ciphertext each time (random iv)', () => {
    const key = generateEncryptionKey();
    const a = encryptSecret('same', key);
    const b = encryptSecret('same', key);
    expect(a).not.toEqual(b);
  });

  it('rejects tampering with the auth tag', () => {
    const key = generateEncryptionKey();
    const wrapped = encryptSecret('payload', key);
    const parts = wrapped.split(':');
    // Flip a bit in the auth tag
    const tag = Buffer.from(parts[3]!, 'base64url');
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString('base64url');
    const tampered = parts.join(':');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('rejects malformed envelopes', () => {
    const key = generateEncryptionKey();
    expect(() => decryptSecret('not-an-envelope', key)).toThrow(/malformed/);
    expect(() => decryptSecret('v9:a:b:c', key)).toThrow(/version/);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => encryptSecret('x', '')).toThrow(/not set/);
    const tooShort = Buffer.alloc(16).toString('base64');
    expect(() => encryptSecret('x', tooShort)).toThrow(/32 bytes/);
  });
});
