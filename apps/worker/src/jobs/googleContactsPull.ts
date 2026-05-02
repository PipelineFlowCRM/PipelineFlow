import { DelayedError, type Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import type {
  GoogleContactsPullJobData,
  GoogleContactsPullJobResult,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { redisConnection } from '../queue.js';
import { acquireLock } from '../lib/redisLock.js';
import {
  buildPeopleClient,
  disableAccount,
  GoogleAccountDisabledError,
  isInvalidGrant,
  loadGoogleAccount,
  PERSON_READ_FIELDS,
  retryAfterMs,
  statusCodeOf,
} from '../integrations/google/peopleClient.js';
import {
  fingerprintPerson,
  normalizePersonFromGoogle,
} from '../integrations/google/contactMapper.js';

// Pull job — fetches contacts from Google and upserts them into PF.
//
// Two modes:
//   - initial: paginates `people.connections.list` from start, upserting
//     every page. Checkpoints `initialPageToken` after each page so a
//     worker crash mid-import resumes where it left off rather than
//     starting from page 1. The final page returns a `nextSyncToken`
//     which we pin for future incremental runs.
//   - incremental: passes the stored `syncToken` and processes only
//     records that changed since. On 410 Gone (token expired after ~7
//     days of disuse) falls back to a full sync.
//
// Echo-loop guard: each upsert hashes the would-be Person projection and
// skips applying if it equals `lastPushedHash`. The push job sets that
// hash after a successful PF→Google write.

const PAGE_SIZE = 100;

export async function processGoogleContactsPull(
  job: Job<GoogleContactsPullJobData, GoogleContactsPullJobResult>,
): Promise<GoogleContactsPullJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  const { googleAccountId, kind } = job.data;

  // Per-account advisory lock — BullMQ's free concurrency knob is global,
  // so without this a manual "Resync now" can run alongside the cron's
  // incremental pull and they'd race on initialPageToken / nextSyncToken.
  // 6 minutes is comfortably above worst-case for the per-job page cap.
  const lockKey = `google-contacts-pull:lock:${googleAccountId}`;
  const release = await acquireLock(redisConnection, lockKey, 6 * 60_000);
  if (!release) {
    log.info({ googleAccountId }, 'pull job: another run holds the lock, skipping');
    return { applied: 0, skipped: 0 };
  }
  try {
    return await runPull(job, log);
  } finally {
    await release();
  }
}

type ChildLogger = typeof logger;

async function runPull(
  job: Job<GoogleContactsPullJobData, GoogleContactsPullJobResult>,
  log: ChildLogger,
): Promise<GoogleContactsPullJobResult> {
  const { googleAccountId, kind } = job.data;
  const account = await loadGoogleAccount(googleAccountId);
  if (!account) {
    log.warn({ googleAccountId }, 'pull job: account not found, skipping');
    return { applied: 0, skipped: 0 };
  }
  if (account.disabledAt) {
    log.info({ googleAccountId, reason: account.disabledReason }, 'pull job: account disabled');
    return { applied: 0, skipped: 0 };
  }
  const sync = await prisma.googleContactsSync.findUnique({
    where: { googleAccountId },
  });
  if (!sync || !sync.inboundEnabled) {
    return { applied: 0, skipped: 0 };
  }

  let handle;
  try {
    handle = await buildPeopleClient(account);
  } catch (err) {
    if (err instanceof GoogleAccountDisabledError) {
      return { applied: 0, skipped: 0 };
    }
    throw err;
  }
  const { client } = handle;

  let applied = 0;
  let skipped = 0;
  // Effective kind — we may flip from incremental to full on a 410.
  let effectiveKind: 'initial' | 'incremental' | 'full-fallback' =
    kind === 'initial'
      ? 'initial'
      : sync.fullSyncDoneAt && sync.syncToken
      ? 'incremental'
      : 'initial';
  let pageToken: string | null =
    effectiveKind === 'initial' ? sync.initialPageToken : null;
  let syncToken: string | null = effectiveKind === 'incremental' ? sync.syncToken : null;
  let nextSyncToken: string | undefined;

  // Cap pages per job. Initial imports for very large address books
  // can run hundreds of pages; we don't want to hold a worker slot for
  // 30 minutes. Stop after this many pages and let the next cron tick
  // pick up the next batch — initialPageToken keeps us in flow.
  const MAX_PAGES_PER_JOB = 25;
  let pagesThisRun = 0;

  while (pagesThisRun < MAX_PAGES_PER_JOB) {
    pagesThisRun++;
    let response;
    try {
      const params: Record<string, unknown> = {
        resourceName: 'people/me',
        pageSize: PAGE_SIZE,
        personFields: PERSON_READ_FIELDS,
        sources: ['READ_SOURCE_TYPE_CONTACT'],
      };
      if (pageToken) params.pageToken = pageToken;
      if (syncToken) {
        params.syncToken = syncToken;
        params.requestSyncToken = true;
      } else if (effectiveKind === 'initial') {
        params.requestSyncToken = true;
      }
      response = await client.people.connections.list(params);
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        return { applied, skipped };
      }
      const status = statusCodeOf(err);
      if (status === 410 && syncToken) {
        // Sync token expired (Google holds them ~7 days). Restart as
        // a full sync; existing link rows stay so etags warm-start.
        log.info({ googleAccountId }, 'syncToken expired, falling back to full sync');
        syncToken = null;
        pageToken = null;
        effectiveKind = 'full-fallback';
        continue;
      }
      if (status === 429) {
        // Defer with Google's suggested delay rather than burning the
        // default backoff. BullMQ DelayedError needs the job moved to
        // delayed via job.moveToDelayed before throwing.
        const delayMs = retryAfterMs(err);
        const ts = Date.now() + delayMs;
        await job.moveToDelayed(ts, job.token);
        throw new DelayedError();
      }
      throw err;
    }

    const connections = response.data.connections ?? [];
    for (const person of connections) {
      try {
        const result = await applyPersonToPF(googleAccountId, person);
        if (result === 'applied') applied++;
        else skipped++;
      } catch (err) {
        log.warn(
          { err, resourceName: person.resourceName },
          'failed to apply person to PF, continuing',
        );
        skipped++;
      }
    }

    // Persist progress so a crash mid-job resumes here.
    if (effectiveKind === 'initial' || effectiveKind === 'full-fallback') {
      await prisma.googleContactsSync.update({
        where: { googleAccountId },
        data: {
          initialPageToken: response.data.nextPageToken ?? null,
          initialImportedCount: { increment: connections.length },
          lastPulledAt: new Date(),
        },
      });
    } else {
      await prisma.googleContactsSync.update({
        where: { googleAccountId },
        data: { lastPulledAt: new Date() },
      });
    }

    if (response.data.nextSyncToken) {
      nextSyncToken = response.data.nextSyncToken;
    }
    pageToken = response.data.nextPageToken ?? null;
    syncToken = null; // syncToken is only valid on the first page
    if (!pageToken) break;
  }

  // If we stopped because we hit the per-job cap, leave initialPageToken
  // set and let the next run continue. Don't pin a syncToken yet.
  if (pageToken) {
    log.info(
      { googleAccountId, pagesThisRun, applied, skipped },
      'pull paused at page cap; will resume next run',
    );
    return { applied, skipped };
  }

  // Reached the end. Pin the syncToken (if Google issued one) and clear
  // initial-import bookkeeping.
  const initialDoneNow = effectiveKind !== 'incremental' && !sync.fullSyncDoneAt;
  await prisma.googleContactsSync.update({
    where: { googleAccountId },
    data: {
      initialPageToken: null,
      ...(nextSyncToken ? { syncToken: nextSyncToken } : {}),
      ...(initialDoneNow ? { fullSyncDoneAt: new Date() } : {}),
      lastPulledAt: new Date(),
    },
  });

  log.info(
    { googleAccountId, applied, skipped, initialDoneNow, kind: effectiveKind },
    'pull job complete',
  );
  return { applied, skipped, initialDoneNow };
}

type ApplyOutcome = 'applied' | 'skipped';

async function applyPersonToPF(
  googleAccountId: number,
  person: import('googleapis').people_v1.Schema$Person,
): Promise<ApplyOutcome> {
  // People sometimes returns "deleted" entries with `metadata.deleted=true`
  // — propagate as a contact deletion if we have a link, otherwise ignore.
  if (person.metadata?.deleted === true) {
    if (!person.resourceName) return 'skipped';
    await deleteLinkedContactIfOrphaned(googleAccountId, person.resourceName);
    return 'applied';
  }

  if (!person.resourceName) return 'skipped';

  const norm = normalizePersonFromGoogle(person);
  // Skip Person entries that don't carry enough to make a useful PF row.
  if (!norm.firstName && !norm.lastName && !norm.email) {
    return 'skipped';
  }

  const incomingHash = fingerprintPerson({
    firstName: norm.firstName,
    lastName: norm.lastName,
    email: norm.email,
    phone: norm.phone,
    title: norm.title,
    companyName: norm.companyName,
    linkedin: norm.linkedin,
    notes: norm.notes,
  });

  // Resolve company name to an id, creating-or-matching case-insensitively.
  // The race-safe pattern is findFirst → create → catch P2002 → re-findFirst.
  const companyId = norm.companyName
    ? await resolveCompany(norm.companyName)
    : null;

  const result = await prisma.$transaction(async (tx) => {
    // 1) Existing link for (account, resourceName)?
    const existingLink = await tx.contactGoogleLink.findUnique({
      where: {
        googleAccountId_resourceName: {
          googleAccountId,
          resourceName: norm.resourceName,
        },
      },
    });
    if (existingLink) {
      // Echo guard — if the inbound matches what we last *pushed*, skip.
      if (existingLink.lastPushedHash === incomingHash) {
        await tx.contactGoogleLink.update({
          where: { id: existingLink.id },
          data: {
            etag: norm.etag,
            lastSyncedAt: new Date(),
            lastPulledHash: incomingHash,
          },
        });
        return 'skipped' as const;
      }
      // Last-write-wins by updateTime vs Contact.updatedAt.
      const contact = await tx.contact.findUnique({
        where: { id: existingLink.contactId },
        select: { updatedAt: true },
      });
      if (
        contact &&
        norm.updateTime &&
        norm.updateTime.getTime() < contact.updatedAt.getTime()
      ) {
        // PF is newer; let the next push reconcile if outbound is on.
        await tx.contactGoogleLink.update({
          where: { id: existingLink.id },
          data: { etag: norm.etag, lastSyncedAt: new Date() },
        });
        return 'skipped' as const;
      }
      // Gentler last-write-wins: when Google has a non-null value for
      // a field we apply it; when Google has null we leave the existing
      // PF value alone. Otherwise a Google contact with no email would
      // erase an email the user manually added in PF — a destructive
      // surprise that's hard to recover from. Users who want to clear
      // a field can do it in PF directly.
      const updateData: Prisma.ContactUpdateInput = {};
      if (norm.firstName) updateData.firstName = norm.firstName;
      if (norm.lastName) updateData.lastName = norm.lastName;
      if (norm.email !== null) updateData.email = norm.email;
      if (norm.phone !== null) updateData.phone = norm.phone;
      if (norm.title !== null) updateData.title = norm.title;
      if (norm.linkedin !== null) updateData.linkedin = norm.linkedin;
      if (norm.notes !== null) updateData.notes = norm.notes;
      if (companyId !== null) {
        updateData.company = { connect: { id: companyId } };
      }
      await tx.contact.update({
        where: { id: existingLink.contactId },
        data: updateData,
      });
      await tx.contactGoogleLink.update({
        where: { id: existingLink.id },
        data: {
          etag: norm.etag,
          lastSyncedAt: new Date(),
          lastPulledHash: incomingHash,
        },
      });
      return 'applied' as const;
    }

    // 2) No link yet — try to match an existing PF Contact by email.
    let matched: { id: number } | null = null;
    if (norm.email) {
      matched = await tx.contact.findFirst({
        where: { email: { equals: norm.email, mode: 'insensitive' } },
        select: { id: true },
      });
    }

    let contactId: number;
    if (matched) {
      contactId = matched.id;
      // Don't blindly overwrite a matched contact's fields — that would
      // surprise users who already populated the PF row. Only fill in
      // fields that are currently null.
      const before = await tx.contact.findUnique({
        where: { id: contactId },
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          title: true,
          linkedin: true,
          notes: true,
          companyId: true,
        },
      });
      if (before) {
        await tx.contact.update({
          where: { id: contactId },
          data: {
            firstName: before.firstName || norm.firstName || 'Unknown',
            lastName: before.lastName || norm.lastName || '',
            phone: before.phone ?? norm.phone,
            title: before.title ?? norm.title,
            linkedin: before.linkedin ?? norm.linkedin,
            notes: before.notes ?? norm.notes,
            companyId: before.companyId ?? companyId,
          },
        });
      }
    } else {
      const created = await tx.contact.create({
        data: {
          firstName: norm.firstName || 'Unknown',
          lastName: norm.lastName || '',
          email: norm.email,
          phone: norm.phone,
          title: norm.title,
          linkedin: norm.linkedin,
          notes: norm.notes,
          companyId,
        },
        select: { id: true },
      });
      contactId = created.id;
    }
    await tx.contactGoogleLink.create({
      data: {
        contactId,
        googleAccountId,
        resourceName: norm.resourceName,
        etag: norm.etag,
        lastPulledHash: incomingHash,
      },
    });
    return 'applied' as const;
  });
  return result;
}

async function deleteLinkedContactIfOrphaned(
  googleAccountId: number,
  resourceName: string,
): Promise<void> {
  const link = await prisma.contactGoogleLink.findUnique({
    where: { googleAccountId_resourceName: { googleAccountId, resourceName } },
  });
  if (!link) return;
  // If the contact has links from other connected users, the contact
  // stays — only this user's link goes away. If this is the last link,
  // we leave the Contact row in place (the user might have valuable
  // data attached: deals, tags, notes); only the link is removed.
  await prisma.contactGoogleLink.delete({ where: { id: link.id } });
}

async function resolveCompany(name: string): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const found = await prisma.company.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
    select: { id: true },
  });
  if (found) return found.id;
  try {
    const created = await prisma.company.create({
      data: { name: trimmed },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost the case-insensitive race against another concurrent
      // pull. Re-find and return.
      const after = await prisma.company.findFirst({
        where: { name: { equals: trimmed, mode: 'insensitive' } },
        select: { id: true },
      });
      return after?.id ?? null;
    }
    throw err;
  }
}
