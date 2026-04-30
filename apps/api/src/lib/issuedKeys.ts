// Tracks S3 keys that the API has just issued via /uploads/presign so we can
// reject /uploads/attachments calls that try to register an arbitrary key.
// Single-process in-memory store: when the API is horizontally scaled, swap
// for Redis (or convert to a signed token).
const TTL_MS = 6 * 60_000; // 6 min — covers a 5-min presign + 1 min slack

const issued = new Map<string, number>();

function gc(now: number) {
  // Sweep on each call (cheap; map stays small in practice).
  for (const [key, expiresAt] of issued) {
    if (expiresAt < now) issued.delete(key);
  }
}

export function rememberIssuedKey(key: string): void {
  const now = Date.now();
  gc(now);
  issued.set(key, now + TTL_MS);
}

export function consumeIssuedKey(key: string): boolean {
  const now = Date.now();
  gc(now);
  const expiresAt = issued.get(key);
  if (!expiresAt || expiresAt < now) return false;
  issued.delete(key);
  return true;
}
