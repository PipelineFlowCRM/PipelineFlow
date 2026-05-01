import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';

export type AuditOutcome =
  | 'success'
  | 'error'
  | 'approval_required'
  | 'approval_consumed';

export interface AuditEvent {
  tokenId?: string | null;
  actorUserId?: number | null;
  toolName: string;
  outcome: AuditOutcome;
  args?: unknown;
  summary?: string;
  errorMessage?: string;
  approvalId?: string;
}

// Hard cap on the persisted args blob. Agents can be chatty — and the
// args sometimes embed user content (notes, descriptions). We keep
// enough context to reconstruct what was attempted but cap at ~4KB so
// a single bad call can't blow up the log table.
const ARGS_MAX_BYTES = 4_096;

function truncateArgs(args: unknown): Prisma.InputJsonValue | undefined {
  if (args === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return { _truncated: true, reason: 'unserializable' } as Prisma.InputJsonValue;
  }
  if (serialized.length <= ARGS_MAX_BYTES) {
    // Round-trip through JSON to coerce unsupported types out (BigInts,
    // Dates) and arrive at a Prisma-acceptable JSON value.
    return JSON.parse(serialized) as Prisma.InputJsonValue;
  }
  return {
    _truncated: true,
    preview: serialized.slice(0, ARGS_MAX_BYTES),
  } as Prisma.InputJsonValue;
}

// Single entry point for MCP audit writes. Failures inside this are
// logged and swallowed — losing an audit row must never take down the
// caller's response. (If audit reliability is upgraded, swap pino for
// a queued sink rather than blocking the request path.)
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    await prisma.mcpAuditEvent.create({
      data: {
        tokenId: event.tokenId ?? null,
        actorUserId: event.actorUserId ?? null,
        toolName: event.toolName,
        outcome: event.outcome,
        args: truncateArgs(event.args),
        summary: event.summary ?? null,
        errorMessage: event.errorMessage ?? null,
        approvalId: event.approvalId ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, event }, 'mcp audit write failed');
  }
}
