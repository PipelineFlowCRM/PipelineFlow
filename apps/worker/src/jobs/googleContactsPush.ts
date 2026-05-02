import type { Job } from 'bullmq';
import type {
  GoogleContactsPushJobData,
  GoogleContactsPushJobResult,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  buildPeopleClient,
  disableAccount,
  GoogleAccountDisabledError,
  isInvalidGrant,
  loadGoogleAccount,
  PERSON_READ_FIELDS,
  PERSON_UPDATE_PERSON_FIELDS,
  statusCodeOf,
} from '../integrations/google/peopleClient.js';
import {
  buildPersonForCreate,
  fingerprintPerson,
  mergePersonForUpdate,
  type PFContactForPush,
} from '../integrations/google/contactMapper.js';

// Push job — applies a PF contact change to Google.
//
// Outcomes:
//   - pushed: the contact was created or updated in Google.
//   - skipped-echo: the would-be body matches lastPulledHash, meaning
//     the contact's current PF state was just received from Google.
//     Pushing would echo back; skip.
//   - skipped-disabled: outbound is off for this account or the account
//     is disabled. Common case — outbound is opt-in.
//   - skipped-missing-link: a delete that arrived without a known link
//     row. Already nothing to do.

export async function processGoogleContactsPush(
  job: Job<GoogleContactsPushJobData, GoogleContactsPushJobResult>,
): Promise<GoogleContactsPushJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  const { googleAccountId } = job.data;

  const account = await loadGoogleAccount(googleAccountId);
  if (!account || account.disabledAt) {
    return { outcome: 'skipped-disabled' };
  }
  const sync = await prisma.googleContactsSync.findUnique({
    where: { googleAccountId },
  });
  if (!sync || !sync.outboundEnabled) {
    return { outcome: 'skipped-disabled' };
  }

  let handle;
  try {
    handle = await buildPeopleClient(account);
  } catch (err) {
    if (err instanceof GoogleAccountDisabledError) {
      return { outcome: 'skipped-disabled' };
    }
    throw err;
  }
  const { client } = handle;

  if (job.data.kind === 'delete') {
    try {
      await client.people.deleteContact({ resourceName: job.data.resourceName });
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        return { outcome: 'skipped-disabled' };
      }
      const status = statusCodeOf(err);
      if (status === 404 || status === 410) {
        // Already gone — fine. Both codes mean "the resource isn't
        // there anymore"; HTTP 410 specifically means it was deleted.
      } else {
        throw err;
      }
    }
    await prisma.contactGoogleLink.deleteMany({
      where: { googleAccountId, resourceName: job.data.resourceName },
    });
    await prisma.googleContactsSync.update({
      where: { googleAccountId },
      data: { lastPushedAt: new Date() },
    });
    return { outcome: 'pushed' };
  }

  // upsert
  const contact = await prisma.contact.findUnique({
    where: { id: job.data.contactId },
    include: { company: { select: { name: true } } },
  });
  if (!contact) {
    // Contact was deleted between enqueue and processing. The delete
    // job (if outbound is on) will handle the Google side; nothing to
    // do here.
    return { outcome: 'skipped-missing-link' };
  }
  const pfBody: PFContactForPush = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    title: contact.title,
    companyName: contact.company?.name ?? null,
    linkedin: contact.linkedin,
    notes: contact.notes,
  };
  const wouldHash = fingerprintPerson(pfBody);

  // A single PF Contact can in principle have multiple links to the
  // same Google account — happens when initial pull matches two
  // separate Google contacts onto the same PF row by email. Update
  // them all so we don't silently desync the duplicates.
  const existingLinks = await prisma.contactGoogleLink.findMany({
    where: { googleAccountId, contactId: contact.id },
  });

  // Echo guard — if every link's lastPulledHash already matches what
  // we'd push, skip. (We could be more granular and skip per-link, but
  // the all-match case is the common one and a partial-match push is
  // rare enough to just always run.)
  if (existingLinks.length > 0 && existingLinks.every((l) => l.lastPulledHash === wouldHash)) {
    return { outcome: 'skipped-echo' };
  }

  if (existingLinks.length === 0) {
    // Create on Google.
    const personBody = buildPersonForCreate(pfBody);
    let created;
    try {
      const resp = await client.people.createContact({
        personFields: PERSON_READ_FIELDS,
        requestBody: personBody,
      });
      created = resp.data;
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        return { outcome: 'skipped-disabled' };
      }
      throw err;
    }
    if (!created.resourceName || !created.etag) {
      throw new Error('createContact: response missing resourceName or etag');
    }
    await prisma.contactGoogleLink.create({
      data: {
        contactId: contact.id,
        googleAccountId,
        resourceName: created.resourceName,
        etag: created.etag,
        lastPushedHash: wouldHash,
      },
    });
    await prisma.googleContactsSync.update({
      where: { googleAccountId },
      data: { lastPushedAt: new Date() },
    });
    return { outcome: 'pushed' };
  }

  // Update each existing link. Skip links whose lastPulledHash matches
  // wouldHash — those are individually echo-clean. The rare multi-link
  // case (one PF Contact mapped to several Google entries via email
  // match) gets handled correctly: each link's resource is updated.
  let pushedAny = false;
  for (const link of existingLinks) {
    if (link.lastPulledHash === wouldHash) continue;
    const result = await pushOneLink({
      client,
      googleAccountId,
      contactId: contact.id,
      pfBody,
      wouldHash,
      link,
    });
    if (result === 'disabled') return { outcome: 'skipped-disabled' };
    if (result === 'pushed') pushedAny = true;
  }
  if (pushedAny) {
    await prisma.googleContactsSync.update({
      where: { googleAccountId },
      data: { lastPushedAt: new Date() },
    });
  }
  return { outcome: pushedAny ? 'pushed' : 'skipped-echo' };
}

type PushOneArgs = {
  client: import('googleapis').people_v1.People;
  googleAccountId: number;
  contactId: number;
  pfBody: PFContactForPush;
  wouldHash: string;
  link: { id: number; resourceName: string; etag: string };
};

// Update a single link's resource. Returns:
//   - 'pushed': resource updated (or recreated on 404/410).
//   - 'disabled': caller should bail; account got marked disabled.
// Throws on a persistent etag conflict so BullMQ retries the whole job.
async function pushOneLink({
  client,
  googleAccountId,
  contactId,
  pfBody,
  wouldHash,
  link,
}: PushOneArgs): Promise<'pushed' | 'disabled'> {
  let attemptsLeft = 2;
  while (attemptsLeft > 0) {
    attemptsLeft--;
    let existingPerson;
    try {
      const resp = await client.people.get({
        resourceName: link.resourceName,
        personFields: PERSON_READ_FIELDS,
      });
      existingPerson = resp.data;
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        return 'disabled';
      }
      const status = statusCodeOf(err);
      if (status === 404 || status === 410) {
        // Gone on Google — recreate from PF state. Drop the stale link
        // first so the unique (account, resourceName) constraint doesn't
        // collide if Google happens to reissue the same id.
        await prisma.contactGoogleLink.delete({ where: { id: link.id } });
        const personBody = buildPersonForCreate(pfBody);
        const recreate = await client.people.createContact({
          personFields: PERSON_READ_FIELDS,
          requestBody: personBody,
        });
        const created = recreate.data;
        if (!created.resourceName || !created.etag) {
          throw new Error('createContact (recreate): missing resourceName or etag');
        }
        await prisma.contactGoogleLink.create({
          data: {
            contactId,
            googleAccountId,
            resourceName: created.resourceName,
            etag: created.etag,
            lastPushedHash: wouldHash,
          },
        });
        return 'pushed';
      }
      throw err;
    }

    // The etag we send is the one we just got from this iteration's
    // get() — not the cached link.etag, which may be days stale.
    const etag = existingPerson.etag ?? link.etag;
    const merged = mergePersonForUpdate(pfBody, existingPerson);
    merged.etag = etag;

    try {
      const resp = await client.people.updateContact({
        resourceName: link.resourceName,
        updatePersonFields: PERSON_UPDATE_PERSON_FIELDS,
        requestBody: merged,
      });
      const updated = resp.data;
      await prisma.contactGoogleLink.update({
        where: { id: link.id },
        data: {
          etag: updated.etag ?? etag,
          lastSyncedAt: new Date(),
          lastPushedHash: wouldHash,
        },
      });
      return 'pushed';
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        return 'disabled';
      }
      const status = statusCodeOf(err);
      if (status === 412) {
        if (attemptsLeft > 0) {
          // etag mismatch — loop back, next iteration's get() pulls a
          // fresh etag and we try again.
          logger.info(
            { googleAccountId, resourceName: link.resourceName },
            'etag mismatch on update, refetching',
          );
          continue;
        }
        // Out of retries on a stubborn 412 — throw a descriptive error
        // so /admin/queues shows what's actually happening (rather than
        // a bare HTTP code). BullMQ retries the whole job after this.
        throw new Error(
          `updateContact: persistent etag conflict on ${link.resourceName}`,
        );
      }
      throw err;
    }
  }
  // Unreachable — the loop returns or throws on every path.
  throw new Error('updateContact: unreachable');
}
