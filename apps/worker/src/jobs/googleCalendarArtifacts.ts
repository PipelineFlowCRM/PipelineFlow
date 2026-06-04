import { DelayedError, type Job } from 'bullmq';
import type {
  GoogleCalendarArtifactsJobData,
  GoogleCalendarArtifactsJobResult,
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
  flattenDocBody,
  parseSummaryDoc,
  type ParsedActionItem,
} from '../integrations/google/summaryParser.js';

// Artifact watcher. For each completed Meeting on this account, fetch
// recordings + transcripts from the Meet API and search Drive for the
// "Notes by Gemini" summary doc. On a successful summary fetch, parse
// the body for the excerpt + action items, write the meeting_summary
// Note, and create pending_review Tasks.
//
// Cadence is the artifacts cron (default 10m). Each run scans the
// backlog of unprocessed meetings; we don't queue per-meeting jobs
// because a meeting just-now-completed is cheaper to pick up on the
// next tick than to fan out a job for. Idempotent: re-running with the
// URLs already populated is a no-op (we early-return on
// artifactsProcessedAt).
//
// 6-hour cap: meetings whose end time is more than 6h in the past with
// at least one missing artifact get marked partial=true and stop being
// retried. This bounds the queue work and avoids infinite polling for
// meetings that just won't have artifacts (call too short, organizer
// turned off recording, etc.).

const POST_CALL_GRACE_MS = 5 * 60_000;
// Give up window measured from whichever is later: end-of-meeting OR
// when we first ingested the row. The latter clause is what makes
// backfill work — a meeting from three months ago shouldn't be
// pre-disqualified just because its `scheduledEnd` is older than the
// give-up window. We still get 6h of retries after the worker first
// sees it.
const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;
// Limit how many meetings each run processes — Drive search + Doc read
// are non-trivial calls. The next cron tick picks up anything we miss.
const MAX_MEETINGS_PER_RUN = 25;

export async function processGoogleCalendarArtifacts(
  job: Job<GoogleCalendarArtifactsJobData, GoogleCalendarArtifactsJobResult>,
): Promise<GoogleCalendarArtifactsJobResult> {
  const log = logger.child({ jobId: job.id, jobName: job.name });
  const { googleAccountId } = job.data;

  const release = await acquireLock(
    redisConnection,
    `google-calendar-artifacts:lock:${googleAccountId}`,
    6 * 60_000,
  );
  if (!release) {
    log.info({ googleAccountId }, 'artifacts: another run holds the lock, skipping');
    return { considered: 0, attached: 0, partial: 0 };
  }
  try {
    return await runArtifacts(job, log);
  } finally {
    await release();
  }
}

type ChildLogger = typeof logger;

async function runArtifacts(
  job: Job<GoogleCalendarArtifactsJobData, GoogleCalendarArtifactsJobResult>,
  log: ChildLogger,
): Promise<GoogleCalendarArtifactsJobResult> {
  const { googleAccountId } = job.data;
  const account = await loadGoogleAccount(googleAccountId);
  if (!account || account.disabledAt) {
    return { considered: 0, attached: 0, partial: 0 };
  }
  const sync = await prisma.googleCalendarSync.findUnique({
    where: { googleAccountId },
  });
  if (!sync || !sync.enabled) {
    return { considered: 0, attached: 0, partial: 0 };
  }

  let handle;
  try {
    handle = await buildCalendarHandle(account);
  } catch (err) {
    if (err instanceof GoogleAccountDisabledError) {
      return { considered: 0, attached: 0, partial: 0 };
    }
    throw err;
  }

  // Pick the backlog: meetings ingested by this account that completed
  // at least POST_CALL_GRACE_MS ago and don't have artifacts yet. The
  // give-up cutoff is computed per-row in JS (Prisma's where can't easily
  // express MAX(scheduledEnd, createdAt) + 6h) — we over-fetch slightly
  // and filter, which is fine because we cap at MAX_MEETINGS_PER_RUN
  // before the API calls anyway.
  const now = new Date();
  const cutoffEnd = new Date(now.getTime() - POST_CALL_GRACE_MS);
  const giveUpFromNow = GIVE_UP_AFTER_MS;

  // TODO(soft-delete): this query doesn't filter `deletedAt`, so once a
  // soft-delete write site exists for meetings it would fetch artifacts for
  // archived rows and create Notes + Tasks on them. Add `deletedAt: null`
  // here when meeting soft-archive ships (the calendar-pull status
  // reconciliation already guards this).
  const candidates = await prisma.meeting.findMany({
    where: {
      sourceAccountId: googleAccountId,
      status: { in: ['completed', 'in_progress'] },
      scheduledEnd: { lt: cutoffEnd },
      artifactsProcessedAt: null,
    },
    orderBy: { scheduledEnd: 'desc' },
    // Pull a bit more than we'll process — see partition below.
    take: MAX_MEETINGS_PER_RUN * 4,
  });

  const partition = (m: { scheduledEnd: Date; createdAt: Date }) => {
    // Effective deadline: 6h after whichever is later — the meeting
    // ending or our ingesting it. Backfilled rows therefore get 6h to
    // process even when the meeting itself happened months ago.
    const lastSeen = Math.max(m.scheduledEnd.getTime(), m.createdAt.getTime());
    return now.getTime() - lastSeen > giveUpFromNow ? 'expired' : 'active';
  };

  const expired = candidates.filter((m) => partition(m) === 'expired');
  const active = candidates.filter((m) => partition(m) === 'active');

  if (expired.length > 0) {
    await prisma.meeting.updateMany({
      where: { id: { in: expired.map((m) => m.id) } },
      data: { artifactsProcessedAt: now, artifactsPartial: true },
    });
  }

  const meetings = active.slice(0, MAX_MEETINGS_PER_RUN);

  let considered = 0;
  let attached = 0;
  let partial = 0;

  for (const meeting of meetings) {
    considered++;
    try {
      const result = await processMeetingArtifacts(handle, meeting, log);
      if (result === 'attached') attached++;
      if (result === 'partial') partial++;
    } catch (err) {
      if (isInvalidGrant(err)) {
        await disableAccount(googleAccountId, 'invalid_grant');
        break;
      }
      const status = statusCodeOf(err);
      if (status === 429) {
        const ts = Date.now() + retryAfterMs(err);
        await job.moveToDelayed(ts, job.token);
        throw new DelayedError();
      }
      log.warn(
        { err, meetingId: meeting.id, googleAccountId },
        'artifact run on a single meeting failed; continuing',
      );
    }
  }

  await prisma.googleCalendarSync.update({
    where: { googleAccountId },
    data: { lastArtifactsSyncedAt: now },
  });

  log.info(
    { googleAccountId, considered, attached, partial },
    'artifacts run complete',
  );
  return { considered, attached, partial };
}

type ProcessOutcome = 'attached' | 'partial' | 'unchanged';

async function processMeetingArtifacts(
  handle: Awaited<ReturnType<typeof buildCalendarHandle>>,
  meeting: Awaited<ReturnType<typeof prisma.meeting.findFirst>> & object,
  log: ChildLogger,
): Promise<ProcessOutcome> {
  // Fetch recordings + transcripts via the Meet API. conferenceId is the
  // space id from the Calendar event; the Meet API takes the qualified
  // form `conferenceRecords/{name}`. Records live for ~30d before being
  // garbage-collected by Meet.
  let recordingUrl: string | null = meeting.recordingUrl;
  let recordingDriveId: string | null = meeting.recordingDriveId;
  let transcriptDocUrl: string | null = meeting.transcriptDocUrl;
  let transcriptDocId: string | null = meeting.transcriptDocId;
  let summaryDocUrl: string | null = meeting.summaryDocUrl;
  let summaryDocId: string | null = meeting.summaryDocId;
  let summaryExcerpt: string | null = meeting.summaryExcerpt;

  if (meeting.conferenceId) {
    // The Meet API surfaces conferenceRecords keyed by `conferenceRecords/{record}`.
    // The space id from Calendar is *not* the same as the record id —
    // each call against a recurring space produces a fresh record. We
    // list all records for the space, then pick the latest one whose
    // start time matches the meeting window.
    try {
      const recordsResp = await handle.meet.conferenceRecords.list({
        filter: `space.meeting_code=${meeting.conferenceId}`,
      });
      const records = recordsResp.data.conferenceRecords ?? [];
      const matchedRecord = records.find((r) => recordCoversMeeting(r, meeting));
      if (matchedRecord?.name) {
        const recordings = await handle.meet.conferenceRecords.recordings.list({
          parent: matchedRecord.name,
        });
        const rec = (recordings.data.recordings ?? [])[0];
        if (rec?.driveDestination?.file) {
          recordingDriveId = rec.driveDestination.file;
          recordingUrl = `https://drive.google.com/file/d/${recordingDriveId}/view`;
        }
        const transcripts = await handle.meet.conferenceRecords.transcripts.list({
          parent: matchedRecord.name,
        });
        const tr = (transcripts.data.transcripts ?? [])[0];
        if (tr?.docsDestination?.document) {
          transcriptDocId = tr.docsDestination.document;
          transcriptDocUrl = `https://docs.google.com/document/d/${transcriptDocId}/edit`;
        }
      }
    } catch (err) {
      // 404s on a record that hasn't been written yet are normal
      // pre-grace and stay at debug. Anything else (auth, scope, 5xx)
      // surfaces as a warn so an operator can see it; the next run will
      // still retry, but the operator can investigate persistent
      // failures rather than guessing why artifact buttons stay empty.
      const status = statusCodeOf(err);
      const level = status === 404 ? 'debug' : 'warn';
      log[level](
        { err, meetingId: meeting.id, status },
        'meet API returned an error while fetching artifacts; continuing',
      );
    }
  }

  // Find the Gemini summary doc by searching Drive. The summary is
  // *not* exposed through the Meet API so we have to do this — Gemini
  // names the doc `[Title] - YYYY/MM/DD - Notes by Gemini` (give or
  // take spacing variation), and drops it in the Meet Recordings
  // folder. We search across the whole Drive for the title pattern and
  // narrow on mime type — folder hierarchy assumptions are too fragile.
  if (!summaryDocId) {
    const found = await searchGeminiSummary(handle, meeting);
    if (found) {
      summaryDocId = found.id;
      summaryDocUrl = `https://docs.google.com/document/d/${found.id}/edit`;
    }
  }

  // Read + parse the summary doc body once we know its id. The parser
  // does the heavy lifting (excerpt + action items); we just persist.
  let parsedActions: ParsedActionItem[] = [];
  if (summaryDocId && !summaryExcerpt) {
    try {
      // includeTabsContent=true is required to populate `Document.tabs[]`
      // — without it, the API only returns the default-tab body, which is
      // empty for Gemini docs that put summary + transcript in separate
      // tabs (the common case).
      const doc = await handle.docs.documents.get({
        documentId: summaryDocId,
        includeTabsContent: true,
      });
      const text = flattenDocBody(doc.data);
      const parsed = parseSummaryDoc(text);
      if (parsed.excerpt) summaryExcerpt = parsed.excerpt;
      parsedActions = parsed.actionItems;
    } catch (err) {
      // 404s on docs that just haven't been generated yet are normal —
      // those stay at debug. Anything else (auth, scope mismatch, 5xx)
      // surfaces as a warn so an operator can see it.
      const status = statusCodeOf(err);
      const level = status === 404 ? 'debug' : 'warn';
      log[level](
        { err, meetingId: meeting.id, summaryDocId, status },
        'failed to read summary doc body; continuing',
      );
    }
  }

  const allArtifactsPresent = Boolean(
    recordingUrl && transcriptDocUrl && summaryDocUrl,
  );

  // Persist the URLs and the excerpt. Even if we got nothing new, mark
  // artifactsProcessedAt so the watcher doesn't pick this meeting up
  // again on every tick — it will retry once the sweeper widens its
  // backlog window again, which is bounded by the give-up cap.
  const beforeProcessed = meeting.artifactsProcessedAt;
  await prisma.meeting.update({
    where: { id: meeting.id },
    data: {
      recordingUrl,
      recordingDriveId,
      transcriptDocUrl,
      transcriptDocId,
      summaryDocUrl,
      summaryDocId,
      summaryExcerpt,
      artifactsProcessedAt: allArtifactsPresent ? new Date() : null,
      artifactsPartial: !allArtifactsPresent && isPastGiveUp(meeting),
    },
  });

  // Note + tasks creation happens once we successfully fetched the
  // summary. Idempotent: we look up by (meetingId, source) and skip
  // when one already exists.
  if (summaryDocId && summaryExcerpt) {
    await ensureSummaryNote(meeting, summaryExcerpt, summaryDocUrl);
  }
  if (parsedActions.length > 0) {
    await materializeActionItems(meeting, parsedActions);
  }

  if (allArtifactsPresent) return 'attached';
  if (isPastGiveUp(meeting)) return 'partial';
  // Some new URLs may have landed even if not all three are present;
  // count that as 'attached' once any artifact field flips from null to
  // populated. Use beforeProcessed proxy: if we wrote anything new, it's
  // worth telling the operator the run wasn't a no-op.
  if (
    !beforeProcessed &&
    (recordingUrl || transcriptDocUrl || summaryDocUrl)
  ) {
    return 'attached';
  }
  return 'unchanged';
}

function isPastGiveUp(meeting: { scheduledEnd: Date; createdAt: Date }): boolean {
  const lastSeen = Math.max(meeting.scheduledEnd.getTime(), meeting.createdAt.getTime());
  return Date.now() - lastSeen > GIVE_UP_AFTER_MS;
}

function recordCoversMeeting(
  record: import('googleapis').meet_v2.Schema$ConferenceRecord,
  meeting: { scheduledStart: Date; scheduledEnd: Date },
): boolean {
  if (!record.startTime) return false;
  const start = new Date(record.startTime).getTime();
  // A 30-minute slack on either side handles late starts and meetings
  // that ran long.
  const slack = 30 * 60_000;
  return (
    start >= meeting.scheduledStart.getTime() - slack &&
    start <= meeting.scheduledEnd.getTime() + slack
  );
}

async function searchGeminiSummary(
  handle: Awaited<ReturnType<typeof buildCalendarHandle>>,
  meeting: { title: string; scheduledStart: Date },
): Promise<{ id: string; name: string } | null> {
  // Drive's q syntax: name contains '<title>' AND mimeType=application/vnd.google-apps.document.
  // Drive's q-language requires *both* backslash and single-quote to be
  // escaped with a backslash. Order matters: backslash first so we don't
  // double-escape the backslash we add for the quote. We also require
  // "Gemini" in the name to filter out an organizer-crafted doc that
  // happens to share the meeting title. The match is intentionally
  // loose because Gemini's exact spacing varies — once we've narrowed
  // to "title + Gemini + doc", the candidate set is small and the
  // creation-time check below picks the right one.
  const safeTitle = meeting.title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name contains '${safeTitle}' and name contains 'Gemini' and mimeType = 'application/vnd.google-apps.document'`;
  const list = await handle.drive.files.list({
    q,
    fields: 'files(id,name,createdTime)',
    pageSize: 20,
  });
  const candidates = list.data.files ?? [];
  if (candidates.length === 0) return null;
  // Pick the candidate whose createdTime is closest to scheduledStart,
  // and *only* when it falls within ±24h of the meeting. The window
  // catches Gemini's normal 5–60min post-call generation plus some
  // safety margin for re-generation events; rejecting outside the
  // window prevents matching a doc from a same-title recurring
  // meeting on a different day.
  const MATCH_WINDOW_MS = 24 * 60 * 60_000;
  const target = meeting.scheduledStart.getTime();
  let best: { id: string; name: string } | null = null;
  let bestDelta = Infinity;
  for (const f of candidates) {
    if (!f.id || !f.name) continue;
    if (!f.createdTime) continue;
    const created = new Date(f.createdTime).getTime();
    const delta = Math.abs(created - target);
    if (delta > MATCH_WINDOW_MS) continue;
    if (delta < bestDelta) {
      best = { id: f.id, name: f.name };
      bestDelta = delta;
    }
  }
  return best;
}

async function ensureSummaryNote(
  meeting: { id: number; primaryDealId: number | null; primaryContactId: number | null; primaryCompanyId: number | null },
  excerpt: string,
  summaryDocUrl: string | null,
): Promise<void> {
  const owner = pickNoteOwner(meeting);
  if (!owner) return; // No deal/contact/company to anchor the note to.

  const existing = await prisma.note.findFirst({
    where: { meetingId: meeting.id, source: 'meeting_summary' },
    select: { id: true },
  });
  const content = summaryDocUrl
    ? `${excerpt}\n\n[View full summary](${summaryDocUrl})`
    : excerpt;
  if (existing) {
    await prisma.note.update({
      where: { id: existing.id },
      data: { content },
    });
    return;
  }
  await prisma.note.create({
    data: {
      content,
      meetingId: meeting.id,
      source: 'meeting_summary',
      ...owner,
    },
  });
}

function pickNoteOwner(meeting: {
  primaryDealId: number | null;
  primaryContactId: number | null;
  primaryCompanyId: number | null;
}): { dealId: number } | { contactId: number } | { companyId: number } | null {
  if (meeting.primaryDealId != null) return { dealId: meeting.primaryDealId };
  if (meeting.primaryContactId != null) return { contactId: meeting.primaryContactId };
  if (meeting.primaryCompanyId != null) return { companyId: meeting.primaryCompanyId };
  return null;
}

async function materializeActionItems(
  meeting: {
    id: number;
    primaryDealId: number | null;
    organizerUserId: number | null;
    scheduledEnd: Date;
  },
  items: ParsedActionItem[],
): Promise<void> {
  // 7 days is the spec default. Org-level overrides live on a future
  // settings table — out of scope for v1.
  const dueDate = new Date(meeting.scheduledEnd.getTime() + 7 * 86_400_000);

  for (const item of items) {
    // Skip items the parser stripped to nothing (e.g. a heading-only
    // bullet, or a line whose owner-prefix matched but body was empty).
    // A blank Task.title is just clutter in the pending-review queue.
    if (!item.action.trim()) continue;
    // Idempotency: skip if a Task with the same source text already
    // exists for this meeting — handles Gemini regenerating the doc.
    const existing = await prisma.task.findFirst({
      where: {
        sourceMeetingId: meeting.id,
        sourceActionItemText: item.rawText,
      },
      select: { id: true },
    });
    if (existing) continue;

    let assigneeUserId: number | null = null;
    let customerCommitment = false;
    if (item.ownerName) {
      const matched = await matchUserByName(item.ownerName);
      if (matched.length === 1) {
        assigneeUserId = matched[0]!.id;
      } else if (matched.length === 0) {
        // No internal user matched — the action item is owned by the
        // customer. Surface as customer_commitment so the deal page can
        // separate "what we said we'd do" from "what they said they'd do".
        customerCommitment = true;
      }
      // Multiple matches: leave assignee unset; the rep picks one in the
      // pending_review UI.
    } else if (meeting.organizerUserId) {
      // Unowned action items default to the meeting organizer — they're
      // the most likely committer in practice.
      assigneeUserId = meeting.organizerUserId;
    }

    await prisma.task.create({
      data: {
        title: item.action,
        status: 'pending_review',
        dealId: meeting.primaryDealId,
        assignedTo: assigneeUserId,
        sourceMeetingId: meeting.id,
        sourceActionItemText: item.rawText,
        autoExtracted: true,
        customerCommitment,
        dueDate,
      },
    });
  }
}

async function matchUserByName(rawName: string): Promise<{ id: number }[]> {
  const name = rawName.trim();
  if (!name) return [];
  // Try full-name match first, then first-name fallback. We
  // intentionally don't fuzzy-match across all users — the cost of a
  // wrong assignee is "the rep has to reassign", but the cost of an
  // ambiguous match in the matcher is "we put the wrong work in front
  // of someone." Strict.
  const full = await prisma.user.findMany({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (full.length > 0) return full;
  const first = name.split(/\s+/)[0];
  if (!first || first === name) return [];
  return prisma.user.findMany({
    where: { name: { startsWith: `${first} `, mode: 'insensitive' } },
    select: { id: true },
  });
}
