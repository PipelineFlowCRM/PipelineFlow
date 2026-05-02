import type { Redis } from 'ioredis';

// Tiny advisory-lock helper backed by Redis SET NX EX. Used to enforce
// per-account serial execution where BullMQ's free `concurrency` knob
// only gives us a global limit. Not a fence — a worker that crashes
// after acquiring will hold the lock until TTL expires, which is fine
// for our use (next cron tick re-attempts).
//
// Pattern:
//   const release = await acquireLock(redis, key, 5*60_000);
//   if (!release) return SKIPPED;
//   try { ... } finally { await release(); }

export type ReleaseFn = () => Promise<void>;

export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<ReleaseFn | null> {
  // Random token so a release can verify the lock is still ours — protects
  // against the case where our TTL expired, someone else acquired, and we
  // try to release "their" lock on the way out.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;

  return async () => {
    // Lua-free conditional delete: GET-and-DEL only if the value is still
    // ours. ioredis's eval avoids a TOCTOU window between GET and DEL.
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await redis.eval(script, 1, key, token);
    } catch {
      // Best-effort; the TTL will expire the key shortly regardless.
    }
  };
}
