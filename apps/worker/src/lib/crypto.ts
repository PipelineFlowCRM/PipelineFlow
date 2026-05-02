import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Mirror of apps/api/src/lib/crypto.ts. Kept duplicated rather than
// promoted to packages/shared because shared is Zod-types-only — adding
// runtime helpers there would invite confusion about what belongs in
// shared vs. apps/*. The two copies must stay in sync; the wire format
// is the load-bearing contract.

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function loadKey(rawBase64: string): Buffer {
  if (!rawBase64) {
    throw new Error(
      'GOOGLE_TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.',
    );
  }
  const buf = Buffer.from(rawBase64, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `GOOGLE_TOKEN_ENCRYPTION_KEY must be exactly ${KEY_BYTES} bytes once base64-decoded; got ${buf.length}.`,
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = loadKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join(':');
}

export function decryptSecret(envelope: string, keyBase64: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new Error('decryptSecret: malformed envelope');
  }
  const [version, ivB64, ctB64, tagB64] = parts;
  if (version !== VERSION) {
    throw new Error(`decryptSecret: unknown envelope version ${version}`);
  }
  const key = loadKey(keyBase64);
  const iv = Buffer.from(ivB64!, 'base64url');
  const ct = Buffer.from(ctB64!, 'base64url');
  const tag = Buffer.from(tagB64!, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
