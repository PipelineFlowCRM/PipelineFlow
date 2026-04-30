import type { Request, RequestHandler } from 'express';
import { HttpError } from './error.js';
import { env } from '../env.js';

interface Bucket {
  count: number;
  resetAt: number;
}

interface Options {
  windowMs?: number;
  max: number;
  keyFn?: (req: Request) => string;
  message?: string;
}

/**
 * Tiny in-memory token bucket. Per-process; for horizontally-scaled deploys
 * swap for a Redis-backed limiter. Sufficient for a single API container,
 * which is the documented topology.
 */
export function rateLimit({
  windowMs = env.RATE_LIMIT_WINDOW_MS,
  max,
  keyFn = (req) => req.ip ?? 'unknown',
  message = 'Too many requests, slow down',
}: Options): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, _res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      next(new HttpError(429, message));
      return;
    }
    // Opportunistic GC: when the map gets large, drop stale entries.
    if (buckets.size > 5_000) {
      for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
    }
    next();
  };
}
