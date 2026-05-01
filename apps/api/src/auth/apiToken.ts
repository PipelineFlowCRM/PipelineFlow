import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { ApiToken, User } from '@prisma/client';
import { prisma } from '../db.js';

// Wire format: `pf_<id>.<secret>`. The leading `pf_` makes the prefix
// recognisable in logs and grep, matching how Stripe / GitHub PAT-style
// tokens self-identify. Splitting the public id out lets us look up the
// row by indexed PK rather than scanning every hash.
//
// We use `.` (dot) as the id/secret delimiter rather than `_` because
// the id and secret are both base64url-encoded — a sub-character in
// base64url's alphabet — so we'd risk ambiguous parsing if the
// delimiter could appear inside either segment. `.` is outside the
// base64url alphabet, so the split is unambiguous.
export const TOKEN_PREFIX = 'pf_';
const SEPARATOR = '.';

// 10 random bytes encoded base64url ≈ 14 chars — opaque public id with
// ~80 bits of entropy. `tok_` is *not* part of the token, just the id.
const ID_BYTES = 10;
// 32 random bytes ≈ 43 chars. ~256 bits of entropy. Verified against the
// stored argon2id hash with `argon2.verify` (constant-time, memory-hard).
const SECRET_BYTES = 32;

export const API_TOKEN_SCOPES = ['read', 'write', 'delete'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export function isValidScope(s: string): s is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(s);
}

export function newTokenId(): string {
  return `tok_${randomBytes(ID_BYTES).toString('base64url')}`;
}

export function newTokenSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function formatToken(id: string, secret: string): string {
  return `${TOKEN_PREFIX}${id}${SEPARATOR}${secret}`;
}

// Reverse of formatToken — splits the wire format back into (id, secret).
// Returns null on any structural mismatch so callers can fail closed
// without distinguishing "malformed" from "wrong" (no oracle for the
// caller to probe id-vs-secret separately).
export function parseToken(raw: string): { id: string; secret: string } | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const body = raw.slice(TOKEN_PREFIX.length);
  // Split on the unambiguous `.` separator. Token id starts with `tok_`
  // and the secret is base64url — neither contains `.`.
  const sep = body.indexOf(SEPARATOR);
  if (sep === -1) return null;
  const id = body.slice(0, sep);
  const secret = body.slice(sep + 1);
  if (!id.startsWith('tok_') || !secret) return null;
  return { id, secret };
}

export const hashTokenSecret = (plain: string) =>
  argon2.hash(plain, { type: argon2.argon2id });

export type LoadedApiToken = ApiToken & { user: User };

// Parses + verifies a raw bearer token, returning the row (with user) on
// success. Returns null for any validation failure — malformed token,
// unknown id, mismatched secret, revoked, or expired. The cost of a bad
// hash is bounded by argon2's memory-hard parameters so timing leakage
// from a missing-row early-return isn't meaningful (and we still do a
// dummy verify to flatten timing if no row exists, see below).
export async function authenticateApiToken(raw: string): Promise<LoadedApiToken | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;
  const row = await prisma.apiToken.findUnique({
    where: { id: parsed.id },
    include: { user: true },
  });
  if (!row) {
    // Run a dummy verify so the response time for "unknown id" matches
    // the response time for "known id, wrong secret" — narrow but real
    // mitigation of token-id enumeration via timing.
    const dummy = await getDummyHash();
    await argon2.verify(dummy, parsed.secret).catch(() => false);
    return null;
  }
  // Verify the secret BEFORE checking revoked/expired so the response
  // time for "live token, wrong secret" matches "revoked/expired token,
  // any secret". Without this, an attacker who guesses a real id could
  // tell live tokens apart from dead ones by timing (live = argon2
  // round-trip, dead = instant return). They couldn't act on it, but
  // it's free to flatten.
  let ok: boolean;
  try {
    ok = await argon2.verify(row.secretHash, parsed.secret);
  } catch {
    return null;
  }
  if (!ok) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  return row;
}

// Argon2id hash of a one-shot random secret — used for the constant-time
// path when an unknown token id is presented. Generated lazily on first
// miss (computing it eagerly is fine but argon2 is heavy enough that we'd
// rather not pay the cost during module init when the app might never
// receive a bad token). Memoized for the process lifetime.
let dummyArgon2HashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyArgon2HashPromise) {
    dummyArgon2HashPromise = argon2.hash(randomBytes(32).toString('base64url'), {
      type: argon2.argon2id,
    });
  }
  return dummyArgon2HashPromise;
}

export function tokenScopes(t: ApiToken): ApiTokenScope[] {
  if (!Array.isArray(t.scopes)) return [];
  return (t.scopes as unknown[]).filter(
    (s): s is ApiTokenScope => typeof s === 'string' && isValidScope(s),
  );
}

export function tokenHasScope(t: ApiToken, scope: ApiTokenScope): boolean {
  return tokenScopes(t).includes(scope);
}

// Lazily updated to avoid a write on every single MCP call. Same approach
// the session loader uses for `lastSeenAt` — at most once per minute.
const LAST_USED_DEBOUNCE_MS = 60_000;

export async function touchLastUsed(token: ApiToken): Promise<void> {
  const now = Date.now();
  if (token.lastUsedAt && now - token.lastUsedAt.getTime() < LAST_USED_DEBOUNCE_MS) return;
  await prisma.apiToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date(now) } })
    .catch(() => undefined);
}
