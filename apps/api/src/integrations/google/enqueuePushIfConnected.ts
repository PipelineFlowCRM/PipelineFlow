import { prisma } from '../../db.js';
import { enqueueGoogleContactsPush } from '../../lib/queue.js';
import { logger } from '../../lib/logger.js';

// Helper called from the contact CRUD path right after a mutation
// commits. Two responsibilities:
//
//   1. Decide whether a push is even possible — only accounts with
//      outboundEnabled=true and not disabled should push. With outbound
//      off by default, this is a no-op for most users.
//   2. Enqueue one job per applicable Google account. The worker is
//      responsible for the echo-loop hash check, etag handling, and
//      everything else; this helper stays thin.
//
// We deliberately do NOT cache the "any outbound enabled?" check in
// memory: a module-scoped cache would only be invalidated on the api
// process that handled the toggle PATCH, leaving other instances stale
// for the cache TTL after a user enables outbound. Single Postgres
// query per contact mutation is cheap and correct.

/**
 * Kept for callsite compatibility (toggling outbound, disconnect).
 * No-op now that the cache is gone. Removing the calls is fine but
 * keeping them clarifies "this place changes outbound state."
 */
export function invalidateOutboundCache(): void {
  // intentionally empty
}

async function findOutboundAccounts(): Promise<{ googleAccountId: number }[]> {
  return prisma.googleContactsSync.findMany({
    where: { outboundEnabled: true, account: { disabledAt: null } },
    select: { googleAccountId: true },
  });
}

/**
 * Enqueue a push job for every account whose outbound is enabled. Safe
 * to call after every contact create/update — the worker will skip
 * (echo-hash) when there's nothing to do.
 *
 * Failures here are swallowed (logged): a Redis blip must not 500 the
 * user-facing mutation that already committed.
 */
export async function enqueueGoogleContactsPushUpsertIfConnected(
  contactId: number,
): Promise<void> {
  try {
    const accounts = await findOutboundAccounts();
    if (accounts.length === 0) return;
    for (const a of accounts) {
      await enqueueGoogleContactsPush({
        kind: 'upsert',
        contactId,
        googleAccountId: a.googleAccountId,
      });
    }
  } catch (err) {
    logger.warn({ err, contactId }, 'failed to enqueue google contacts push upsert');
  }
}

/**
 * Enqueue delete jobs for a captured set of links. Caller must capture
 * the link rows *before* deleting the Contact, since the FK cascade
 * removes them when the Contact row is dropped.
 *
 * Only emits a delete to accounts with outboundEnabled — links on
 * inbound-only accounts stay in their address book (the UI explains
 * this trade-off).
 */
export async function enqueueGoogleContactsPushDeleteForLinks(
  links: ReadonlyArray<{ googleAccountId: number; resourceName: string }>,
): Promise<void> {
  if (links.length === 0) return;
  try {
    const ids = links.map((l) => l.googleAccountId);
    const allowed = await prisma.googleContactsSync.findMany({
      where: {
        googleAccountId: { in: ids },
        outboundEnabled: true,
        account: { disabledAt: null },
      },
      select: { googleAccountId: true },
    });
    const allowedSet = new Set(allowed.map((a) => a.googleAccountId));
    for (const link of links) {
      if (!allowedSet.has(link.googleAccountId)) continue;
      await enqueueGoogleContactsPush({
        kind: 'delete',
        resourceName: link.resourceName,
        googleAccountId: link.googleAccountId,
      });
    }
  } catch (err) {
    logger.warn({ err, count: links.length }, 'failed to enqueue google contacts push delete');
  }
}
