import argon2 from 'argon2';
import { pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto';

export const hashPassword = (plain: string) => argon2.hash(plain, { type: argon2.argon2id });

/**
 * Verify a password against any of the hash formats this DB might contain:
 * - argon2 (`$argon2id$…`) — what new accounts use.
 * - Werkzeug scrypt (`scrypt:N:r:p$salt$hashHex`) — imported from the Flask app.
 * - Werkzeug pbkdf2 (`pbkdf2:algo:iterations$salt$hashHex`) — older Werkzeug default.
 *
 * On a successful non-argon2 match the caller can opportunistically re-hash
 * the password with `hashPassword` to upgrade the row.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  // Each branch is wrapped: a malformed hash (corruption, truncation) should
  // be a graceful "wrong password" rather than a 500 from the auth route.
  try {
    if (hash.startsWith('$argon2')) return await argon2.verify(hash, plain);
    if (hash.startsWith('scrypt:')) return verifyWerkzeugScrypt(hash, plain);
    if (hash.startsWith('pbkdf2:')) return verifyWerkzeugPbkdf2(hash, plain);
  } catch {
    return false;
  }
  return false;
}

/** Indicates the hash uses a legacy format and the caller may want to re-hash on success. */
export const isLegacyHash = (hash: string) =>
  hash.startsWith('scrypt:') || hash.startsWith('pbkdf2:');

function verifyWerkzeugScrypt(hash: string, plain: string): boolean {
  const [method, salt, hashHex] = hash.split('$');
  if (!method || !salt || !hashHex) return false;
  const parts = method.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!N || !r || !p) return false;
  // Defensive bound: legitimate Werkzeug hashes use modest N (32768). Refuse
  // anything that would request gigabytes of memory or minutes of CPU — even
  // though hash strings are DB-controlled, an out-of-band data ingest could
  // sneak something pathological in.
  if (N > 1 << 17 || r > 16 || p > 16) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let derived: Buffer;
  try {
    derived = scryptSync(plain, salt, expected.length, {
      N, r, p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function verifyWerkzeugPbkdf2(hash: string, plain: string): boolean {
  const [method, salt, hashHex] = hash.split('$');
  if (!method || !salt || !hashHex) return false;
  const parts = method.split(':');
  if (parts[0] !== 'pbkdf2') return false;
  const algo = parts[1] ?? 'sha256';
  const iterations = Number(parts[2] ?? 0);
  if (!iterations) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let derived: Buffer;
  try {
    derived = pbkdf2Sync(plain, salt, iterations, expected.length, algo);
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
