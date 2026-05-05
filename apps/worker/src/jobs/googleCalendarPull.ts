import { DelayedError, type Job } from 'bullmq';
import type {
  GoogleCalendarPullJobData,
  GoogleCalendarPullJobResult,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { redisConnection } from '../queue.js';
import { acquireLock } from '../lib/redisLock.js';
import { buildCalendarHandle } from '../integrations/google/calendarClient.js';
import {
  disableAccount,
  GoogleAccountDisabledError,
  isInvalidGrant,
  loadGoogleAccount,
  retryAfterMs,
  statusCodeOf,
} from '../integrations/google/peopleClient.js';
import {
  decideMatch,
  domainOf,
  type CompanyCandidate,
  type ContactCandidate,
  type DealCandidate,
  type MatcherInputs,
} from '../integrations/google/meetingMatcher.js';

// Calendar pull job. One run per account per cron tick — the recurring
// jobId pin in the api-side producer ensures we don't queue parallel
// pulls for the same account.
//
// The job is idempotent: re-running with the same syncToken or a fresh
// re-list of the lookback window simply re-upserts every event. Meeting
// rows are keyed on `calendarEventId` (UNIQUE), so duplicate ingest
// collapses to a noop.
//
// What "ingest" means here:
//   1. List events (delta via syncToken, fall back to bounded re-list).
//   2. Filter out events with no external attendees — internal-only
//      meetings are noise, per spec.
//   3. Upsert the Meeting row + replace its MeetingAttendee rows.
//   4. If the Meeting is fresh (link_status = unlinked), run the matcher
//      and persist the decision + audit row. If the Meeting already has
//      a confirmed link, leave the linkage alone — re-running the
//      matcher would surprise the rep.

// 90-day lookback on the *first* run of an account (or after a manual
// backfill that drops the sync token). Picks up the rep's recent
// customer-facing history so the deal pages aren't suspiciously empty
// for accounts that connected mid-quarter. Subsequent runs use Calendar's
// `syncToken` and only see deltas, so the wide window is a one-time
// cost. Looking forward 60d covers anything pre-staged by an SDR.
const LOOKBACK_DAYS = 90;
const TIME_LOOKAHEAD_DAYS = 60;

export async function processGoogleCalendarPull(
  job: Job<GoogleCalendarPullJobData, GoogleCalendarPullJobResult>,
): Promise<GoogleCalendarPullJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  const { googleAccountId } = job.data;

  // Per-account lock so a manual /resync triggered while a cron tick is
  // in-flight doesn't double-process and race on the syncToken update.
  const release = await acquireLock(
    redisConnection,
    `google-calendar-pull:lock:${googleAccountId}`,
    6 * 60_000,
  );
  if (!release) {
    log.info({ googleAccountId }, 'calendar pull: another run holds the lock, skipping');
    return { upserted: 0, skipped: 0, matched: 0 };
  }
  try {
    return await runPull(job, log);
  } finally {
    await release();
  }
}

type ChildLogger = typeof logger;

async function runPull(
  job: Job<GoogleCalendarPullJobData, GoogleCalendarPullJobResult>,
  log: ChildLogger,
): Promise<GoogleCalendarPullJobResult> {
  const { googleAccountId } = job.data;
  const account = await loadGoogleAccount(googleAccountId);
  if (!account) {
    log.warn({ googleAccountId }, 'calendar pull: account not found');
    return { upserted: 0, skipped: 0, matched: 0 };
  }
  if (account.disabledAt) {
    log.info({ googleAccountId, reason: account.disabledReason }, 'calendar pull: account disabled');
    return { upserted: 0, skipped: 0, matched: 0 };
  }
  const sync = await prisma.googleCalendarSync.findUnique({
    where: { googleAccountId },
  });
  if (!sync || !sync.enabled) {
    return { upserted: 0, skipped: 0, matched: 0 };
  }

  let handle;
  try {
    handle = await buildCalendarHandle(account);
  } catch (err) {
    if (err instanceof GoogleAccountDisabledError) {
      return { upserted: 0, skipped: 0, matched: 0 };
    }
    throw err;
  }
  const { calendar } = handle;

  // Internal-domain detection: default to the connected user's email
  // domain. The spec calls this "configurable per workspace" — that's
  // a P1; v1 uses the implicit-organizer-domain rule which works for
  // every setup we'd realistically demo against.
  const internalDomains = new Set<string>();
  const ownDomain = domainOf(account.googleEmail);
  if (ownDomain) internalDomains.add(ownDomain);

  let upserted = 0;
  let skipped = 0;
  let matched = 0;

  let syncToken: string | null = sync.eventsSyncToken;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  // Cap pages to avoid holding a worker slot indefinitely.
  const MAX_PAGES = 25;
  for (let page = 0; page < MAX_PAGES; page++) {
    let response;
    try {
      const params: import('googleapis').calendar_v3.Params$Resource$Events$List = {
        calendarId: 'primary',
        // showDeleted=true: we want to mark deleted meetings cancelled
        // rather than silently leaving stale rows on the deal timeline.
        showDeleted: true,
        // singleEvents=true: expand recurring series into individual
        // instances. Handling recurrence in the matcher is more complex
        // than it's worth — every customer call is a discrete row.
        singleEvents: true,
        maxResults: 100,
      };
      if (pageToken) params.pageToken = pageToken;
      if (syncToken) {
        params.syncToken = syncToken;
      } else {
        // No delta token — bounded re-list. Lookback covers anything
        // that happened during a brief disconnect; lookahead lets us
        // pre-stage meetings the rep is about to take.
        const now = Date.now();
        params.timeMin = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
        params.timeMax = new Date(now + TIME_LOOKAHEAD_DAYS * 86_400_000).toISOString();
        // orderBy is illegal with a syncToken; only set it when we're
        // doing the windowed re-list.
        params.orderBy = 'startTime';
      }
      response = await calendar.events.list(params);
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        return { upserted, skipped, matched };
      }
      const status = statusCodeOf(err);
      if (status === 410 && syncToken) {
        log.info({ googleAccountId }, 'calendar syncToken expired, re-listing window');
        syncToken = null;
        pageToken = undefined;
        continue;
      }
      if (status === 429) {
        const ts = Date.now() + retryAfterMs(err);
        await job.moveToDelayed(ts, job.token);
        throw new DelayedError();
      }
      throw err;
    }

    const events = response.data.items ?? [];
    for (const ev of events) {
      try {
        const result = await ingestEvent(googleAccountId, internalDomains, ev);
        if (result === 'upserted') upserted++;
        else if (result === 'matched') {
          upserted++;
          matched++;
        } else skipped++;
      } catch (err) {
        log.warn(
          { err, eventId: ev.id, googleAccountId },
          'failed to ingest calendar event, continuing',
        );
        skipped++;
      }
    }

    if (response.data.nextSyncToken) {
      nextSyncToken = response.data.nextSyncToken;
    }
    pageToken = response.data.nextPageToken ?? undefined;
    syncToken = null; // sync token only valid on first page
    if (!pageToken) break;
  }

  await prisma.googleCalendarSync.update({
    where: { googleAccountId },
    data: {
      lastEventsSyncedAt: new Date(),
      ...(nextSyncToken ? { eventsSyncToken: nextSyncToken } : {}),
    },
  });

  log.info(
    { googleAccountId, upserted, skipped, matched },
    'calendar pull complete',
  );
  return { upserted, skipped, matched };
}

type IngestOutcome = 'upserted' | 'matched' | 'skipped';

async function ingestEvent(
  googleAccountId: number,
  internalDomains: Set<string>,
  ev: import('googleapis').calendar_v3.Schema$Event,
): Promise<IngestOutcome> {
  if (!ev.id) return 'skipped';

  // Cancelled events: mark the local row cancelled if present, otherwise
  // ignore (no point creating a Meeting row only to immediately cancel).
  if (ev.status === 'cancelled') {
    await prisma.meeting.updateMany({
      where: { calendarEventId: ev.id },
      data: { status: 'cancelled' },
    });
    return 'upserted';
  }

  // Skip events without enough information to be a real meeting.
  if (!ev.summary || !ev.start || !ev.end) return 'skipped';

  // Pull external + internal attendees apart. External = not on an
  // internal domain and not the organizer's own address. Honor the
  // [no-crm] opt-out marker per spec — descriptions matching it are
  // dropped entirely.
  const description = ev.description ?? '';
  if (/\[no-crm\]/i.test(description)) return 'skipped';

  const attendees = ev.attendees ?? [];
  const externalAttendeeEmails: string[] = [];
  const allAttendeeRows: Array<{
    email: string;
    name: string | null;
    responseStatus: string | null;
    isOrganizer: boolean;
  }> = [];
  for (const a of attendees) {
    if (!a.email) continue;
    const email = a.email.toLowerCase().trim();
    const dom = domainOf(email);
    const isInternal = dom ? internalDomains.has(dom) : false;
    allAttendeeRows.push({
      email,
      name: a.displayName ?? null,
      responseStatus: a.responseStatus ?? null,
      isOrganizer: Boolean(a.organizer),
    });
    if (!isInternal) externalAttendeeEmails.push(email);
  }

  // Skip internal-only meetings — they're noise on the deal timeline.
  if (externalAttendeeEmails.length === 0) return 'skipped';

  // Resolve scheduled times. Calendar can report dateTime (timed events)
  // or date (all-day) — we ignore all-day events; they're not real
  // meetings worth tracking on the deal timeline.
  if (!ev.start.dateTime || !ev.end.dateTime) return 'skipped';
  const scheduledStart = new Date(ev.start.dateTime);
  const scheduledEnd = new Date(ev.end.dateTime);

  // Resolve organizer to internal user when possible. Calendar's
  // `organizer.self` is unreliable for shared / delegated events; we
  // match on email instead. If neither the event nor the attendee
  // list yields an organizer email, skip — `Meeting.organizerEmail` is
  // non-null in the schema and an empty string carries no meaning.
  const eventOrganizer = (ev.organizer?.email ?? '').toLowerCase();
  const attendeeOrganizer = attendees
    .find((a) => a.organizer && a.email)
    ?.email?.toLowerCase() ?? '';
  const organizerEmail = eventOrganizer || attendeeOrganizer;
  if (!organizerEmail) return 'skipped';
  const organizerUser = await prisma.user.findUnique({
    where: { email: organizerEmail },
    select: { id: true },
  });

  const conferenceId = pickConferenceId(ev);
  const status = computeStatus(scheduledStart, scheduledEnd);

  // Pre-resolve attendee → Contact / User outside the transaction. Two
  // batched findMany calls, then a Map lookup per attendee, instead of
  // an N×2 query loop while holding the transaction open. Keeps the
  // transaction tight and stops a single calendar event from pinning a
  // DB connection through ten round-trips.
  const externalEmails = allAttendeeRows
    .filter((a) => {
      const dom = domainOf(a.email);
      return !(dom && internalDomains.has(dom));
    })
    .map((a) => a.email);
  const internalEmails = allAttendeeRows
    .filter((a) => {
      const dom = domainOf(a.email);
      return dom != null && internalDomains.has(dom);
    })
    .map((a) => a.email);

  const [contactRows, userRows] = await Promise.all([
    externalEmails.length === 0
      ? Promise.resolve<Array<{ id: number; email: string | null }>>([])
      : prisma.contact.findMany({
          where: { email: { in: externalEmails, mode: 'insensitive' } },
          select: { id: true, email: true },
        }),
    internalEmails.length === 0
      ? Promise.resolve<Array<{ id: number; email: string }>>([])
      : prisma.user.findMany({
          where: { email: { in: internalEmails } },
          select: { id: true, email: true },
        }),
  ]);
  // Lowercased keys so the lookup is case-insensitive across whatever
  // case the Calendar event used vs. how the address was stored.
  const contactByEmail = new Map<string, number>();
  for (const c of contactRows) {
    if (c.email) contactByEmail.set(c.email.toLowerCase(), c.id);
  }
  const userByEmail = new Map<string, number>();
  for (const u of userRows) userByEmail.set(u.email.toLowerCase(), u.id);

  const upserted = await prisma.$transaction(async (tx) => {
    // Upsert the Meeting row. We deliberately do NOT touch the link_*
    // fields here — those are the matcher's domain. The first-time
    // create starts at link_status='unlinked'; subsequent updates leave
    // any existing linkage alone.
    const existing = await tx.meeting.findUnique({
      where: { calendarEventId: ev.id! },
      select: { id: true, linkStatus: true },
    });

    const baseFields = {
      calendarEventId: ev.id!,
      calendarProvider: 'google',
      sourceAccountId: googleAccountId,
      conferenceId,
      organizerEmail,
      organizerUserId: organizerUser?.id ?? null,
      title: ev.summary!,
      description: description || null,
      scheduledStart,
      scheduledEnd,
      status,
    } as const;

    let meetingId: number;
    if (existing) {
      const updated = await tx.meeting.update({
        where: { id: existing.id },
        data: baseFields,
      });
      meetingId = updated.id;
    } else {
      const created = await tx.meeting.create({
        data: baseFields,
      });
      meetingId = created.id;
    }

    // Replace attendee rows. Cheap on the index, and Calendar can swap
    // out attendees mid-flight (rep moves the meeting to a different
    // contact); upsert-by-(meetingId,email) would also work but a clean
    // diff-replace keeps the row count tight. Lookups come from the
    // pre-resolved Maps above so this loop stays inside the transaction
    // without per-row queries.
    await tx.meetingAttendee.deleteMany({ where: { meetingId } });
    if (allAttendeeRows.length > 0) {
      await tx.meetingAttendee.createMany({
        data: allAttendeeRows.map((a) => {
          const dom = domainOf(a.email);
          const isInternal = dom ? internalDomains.has(dom) : false;
          return {
            meetingId,
            email: a.email,
            name: a.name,
            contactId: isInternal ? null : contactByEmail.get(a.email) ?? null,
            userId: isInternal ? userByEmail.get(a.email) ?? null : null,
            responseStatus: a.responseStatus,
            isOrganizer: a.isOrganizer,
          };
        }),
      });
    }

    // Lock the matcher out for any user-driven terminal state. 'confirmed'
    // means the rep signed off; 'rejected' means the rep explicitly said
    // "this isn't the right deal." Re-running the matcher in either case
    // would silently undo their action on the next cron tick.
    const locked =
      existing?.linkStatus === 'confirmed' || existing?.linkStatus === 'rejected';
    return { meetingId, locked };
  });

  if (upserted.locked) {
    return 'upserted';
  }

  // Run the matcher. Caller hands in already-loaded candidates so the
  // matcher itself stays Prisma-free and unit-testable.
  const matcherInput = await loadMatcherInputs(externalAttendeeEmails, ev.summary!);
  const decision = decideMatch(matcherInput);

  await persistMatchDecision(upserted.meetingId, decision);
  return decision.outcome === 'unlinked' ? 'upserted' : 'matched';
}

// Pull the conferenceRecord name out of a Calendar event. Meet writes
// the record id into conferenceData.entryPoints[].uri — we pluck the
// space identifier off the meet.google.com URL and convert it to the
// `conferenceRecords/...` format the Meet API consumes. The space id is
// stable across re-joins of the same conference.
function pickConferenceId(ev: import('googleapis').calendar_v3.Schema$Event): string | null {
  const data = ev.conferenceData;
  if (!data) return null;
  // Prefer the conferenceId attribute when present — it's the stable
  // space id and exactly what we need.
  if (data.conferenceId) return data.conferenceId;
  // Fall back to parsing the entryPoint URI.
  const ep = data.entryPoints?.find((e) => e.entryPointType === 'video' && e.uri);
  if (!ep?.uri) return null;
  const m = /meet\.google\.com\/([a-z0-9-]+)/i.exec(ep.uri);
  return m ? m[1] ?? null : null;
}

function computeStatus(scheduledStart: Date, scheduledEnd: Date): string {
  const now = Date.now();
  if (now < scheduledStart.getTime()) return 'scheduled';
  if (now < scheduledEnd.getTime()) return 'in_progress';
  return 'completed';
}

async function loadMatcherInputs(
  externalAttendeeEmails: string[],
  eventTitle: string,
): Promise<MatcherInputs> {
  const contacts = await prisma.contact.findMany({
    where: {
      email: { in: externalAttendeeEmails, mode: 'insensitive' },
    },
    select: { id: true, email: true, companyId: true },
  });

  const contactsByAttendee: ContactCandidate[] = contacts.map((c) => ({
    id: c.id,
    email: c.email,
    companyId: c.companyId,
  }));

  // Open deals: anything not on a won/lost stage. The seed and migrations
  // mark won/lost via PipelineStage.isWon / isLost, so the cleanest read
  // is "stage is not isWon and not isLost". A deal can land on the
  // matcher via either contact or company linkage.
  const contactIds = contacts.map((c) => c.id);
  const companyIds = uniqueNumbers(contacts.map((c) => c.companyId).filter((v): v is number => v != null));

  const openDeals = contactIds.length === 0 && companyIds.length === 0
    ? []
    : await prisma.deal.findMany({
        where: {
          AND: [
            { stage: { isWon: false, isLost: false } },
            {
              OR: [
                { primaryContactId: { in: contactIds } },
                { companyId: { in: companyIds } },
              ],
            },
          ],
        },
        select: { id: true, title: true, primaryContactId: true, companyId: true },
      });

  const openDealsByContact = new Map<number, DealCandidate[]>();
  for (const d of openDeals) {
    // Deals attach via primary contact OR company. For matcher purposes
    // we attribute to every contact that could plausibly own it: the
    // primary contact directly, plus any matched contact whose company
    // matches the deal's company.
    const owners = new Set<number>();
    if (d.primaryContactId != null) owners.add(d.primaryContactId);
    for (const c of contacts) {
      if (c.companyId != null && c.companyId === d.companyId) owners.add(c.id);
    }
    for (const ownerId of owners) {
      const list = openDealsByContact.get(ownerId) ?? [];
      list.push({
        id: d.id,
        title: d.title,
        primaryContactId: d.primaryContactId,
        companyId: d.companyId,
      });
      openDealsByContact.set(ownerId, list);
    }
  }

  // Domain-match candidates. Build the domain set from the attendees;
  // any company whose `domains[]` contains any of those is a candidate.
  const domains = uniqueStrings(
    externalAttendeeEmails.map(domainOf).filter((d): d is string => Boolean(d)),
  );
  const companies = domains.length === 0
    ? []
    : await prisma.company.findMany({
        where: { domains: { hasSome: domains } },
        select: { id: true, domains: true },
      });
  const companiesByDomain: CompanyCandidate[] = companies.map((c) => ({
    id: c.id,
    domains: c.domains.map((d) => d.toLowerCase()),
  }));

  return {
    externalAttendeeEmails,
    eventTitle,
    contactsByAttendee,
    openDealsByContact,
    companiesByDomain,
  };
}

async function persistMatchDecision(
  meetingId: number,
  decision: ReturnType<typeof decideMatch>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const linkStatus =
      decision.outcome === 'auto_confirmed'
        ? 'confirmed'
        : decision.outcome === 'suggested'
        ? 'suggested'
        : 'unlinked';

    await tx.meeting.update({
      where: { id: meetingId },
      data: {
        primaryContactId: decision.primaryContactId,
        primaryDealId: decision.primaryDealId,
        primaryCompanyId: decision.primaryCompanyId,
        linkStatus,
        // Decimal columns accept number or string; we hand a number so the
        // round-trip preserves the matcher's confidence value.
        linkConfidence: decision.confidence > 0 ? decision.confidence : null,
        linkMethod: decision.method,
        linkedAt: linkStatus === 'confirmed' ? new Date() : null,
      },
    });

    await tx.meetingLinkAudit.create({
      data: {
        meetingId,
        method: decision.method ?? 'email_match',
        candidates: decision.candidates as unknown as object,
        chosenContactId: decision.primaryContactId,
        chosenDealId: decision.primaryDealId,
        chosenCompanyId: decision.primaryCompanyId,
        confidence: decision.confidence > 0 ? decision.confidence : null,
        outcome: 'accepted',
      },
    });
  });
}

function uniqueNumbers(arr: number[]): number[] {
  return Array.from(new Set(arr));
}
function uniqueStrings(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
