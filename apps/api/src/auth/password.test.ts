import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, isLegacyHash, verifyPassword } from './password.js';

describe('argon2 hashing', () => {
  it('round-trips a fresh hash', async () => {
    const hash = await hashPassword('hunter2');
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword(hash, 'hunter2')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('isLegacyHash distinguishes formats', () => {
    expect(isLegacyHash('$argon2id$v=19$...')).toBe(false);
    expect(isLegacyHash('scrypt:32768:8:1$abc$def')).toBe(true);
    expect(isLegacyHash('pbkdf2:sha256:600000$abc$def')).toBe(true);
  });
});

describe('werkzeug scrypt verification', () => {
  it('verifies a hash produced from the same scrypt parameters', () => {
    const N = 32768, r = 8, p = 1;
    const salt = randomBytes(8).toString('hex');
    const password = 'correct horse battery staple';
    const derived = scryptSync(password, salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 });
    const hash = `scrypt:${N}:${r}:${p}$${salt}$${derived.toString('hex')}`;
    return Promise.all([
      verifyPassword(hash, password).then((v) => expect(v).toBe(true)),
      verifyPassword(hash, 'nope').then((v) => expect(v).toBe(false)),
    ]);
  });

  it('rejects malformed scrypt hashes', async () => {
    expect(await verifyPassword('scrypt:not:a:valid$hash$here', 'x')).toBe(false);
    expect(await verifyPassword('scrypt:0:0:0$salt$00', 'x')).toBe(false);
  });
});

describe('werkzeug pbkdf2 verification', () => {
  it('verifies a hash produced from the same pbkdf2 parameters', async () => {
    const iterations = 10_000;
    const salt = randomBytes(8).toString('hex');
    const password = 'pa$$w0rd';
    const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const hash = `pbkdf2:sha256:${iterations}$${salt}$${derived.toString('hex')}`;
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('rejects iterations=0', async () => {
    expect(await verifyPassword('pbkdf2:sha256:0$salt$00', 'x')).toBe(false);
  });
});

describe('unknown formats', () => {
  it('returns false for unrecognized hashes', async () => {
    expect(await verifyPassword('plaintext-not-a-hash', 'plaintext-not-a-hash')).toBe(false);
    expect(await verifyPassword('', '')).toBe(false);
  });

  it('argon2 verify on garbage does not throw', async () => {
    expect(await verifyPassword('$argon2id$totally-wrong', 'x')).toBe(false);
  });
});
