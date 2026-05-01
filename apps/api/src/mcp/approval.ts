import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db.js';

// How long an issued approval token is valid for. Long enough for an
// agent's tool-call → user-prompt → tool-call round-trip, short enough
// that a leaked confirmation can't be sat on for hours.
export const APPROVAL_TTL_MS = 5 * 60_000;

// `appr_<base64url-12>` — same shape as the webhook event id.
function newApprovalId(): string {
  return `appr_${randomBytes(12).toString('base64url')}`;
}

// Canonical-JSON fingerprint of the args. Sorted keys so two equivalent
// calls produce the same hash regardless of input ordering. The
// fingerprint is what binds an approval to a *specific* destructive
// action — agents can't issue an approval for `delete deal 1` and
// then reuse it on `delete deal 2`.
export function fingerprintArgs(args: unknown): string {
  const canonical = canonicalJSON(args);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalJSON(value: unknown): string {
  // Coerce undefined to a unique sentinel so JSON.stringify(undefined) →
  // undefined doesn't crash createHash().update(). null and undefined
  // remain distinguishable in the fingerprint.
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
    .join(',')}}`;
}

export interface IssueApprovalParams {
  tokenId: string;
  toolName: string;
  args: unknown;
}

// Issues a fresh, unconsumed approval token. Same agent calling the
// same destructive tool with the same args twice in a row gets two
// distinct approval ids — that's intentional, the user's "approve"
// click in their MCP client is what consumes one of them.
export async function issueApproval({
  tokenId,
  toolName,
  args,
}: IssueApprovalParams): Promise<{ id: string; expiresAt: Date }> {
  const id = newApprovalId();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  await prisma.mcpApprovalToken.create({
    data: {
      id,
      tokenId,
      toolName,
      argsFingerprint: fingerprintArgs(args),
      expiresAt,
    },
  });
  return { id, expiresAt };
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'expired' | 'consumed' | 'mismatch' };

// Atomically consume (mark used) an approval token. Returns ok:true only
// if the token exists, hasn't expired, hasn't been consumed, and the
// (toolName, argsFingerprint, tokenId) all match. Implemented as a
// transactional read-then-update so a concurrent second call on the same
// approval id can't both succeed.
export async function consumeApproval(params: {
  approvalId: string;
  tokenId: string;
  toolName: string;
  args: unknown;
}): Promise<ConsumeResult> {
  const fingerprint = fingerprintArgs(params.args);
  return prisma.$transaction(async (tx) => {
    const row = await tx.mcpApprovalToken.findUnique({
      where: { id: params.approvalId },
    });
    if (!row) return { ok: false as const, reason: 'not_found' as const };
    if (row.tokenId !== params.tokenId) {
      // Approval was issued for a different agent token — refuse
      // without leaking which fields mismatched.
      return { ok: false as const, reason: 'mismatch' as const };
    }
    if (row.toolName !== params.toolName) {
      return { ok: false as const, reason: 'mismatch' as const };
    }
    if (row.argsFingerprint !== fingerprint) {
      return { ok: false as const, reason: 'mismatch' as const };
    }
    if (row.consumedAt) return { ok: false as const, reason: 'consumed' as const };
    if (row.expiresAt < new Date()) return { ok: false as const, reason: 'expired' as const };
    await tx.mcpApprovalToken.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    return { ok: true as const };
  });
}

// Best-effort cleanup of long-expired tokens. Called opportunistically
// from the MCP layer; not on a cron because this table is tiny in
// practice (5-minute TTL × low call rate). 24h grace lets the audit log
// still join against the row for a day after expiry.
const PURGE_GRACE_MS = 24 * 60 * 60_000;
let lastPurgeAt = 0;
const PURGE_DEBOUNCE_MS = 5 * 60_000;

export async function maybePurgeApprovals(): Promise<void> {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_DEBOUNCE_MS) return;
  lastPurgeAt = now;
  await prisma.mcpApprovalToken
    .deleteMany({ where: { expiresAt: { lt: new Date(now - PURGE_GRACE_MS) } } })
    .catch(() => undefined);
}
