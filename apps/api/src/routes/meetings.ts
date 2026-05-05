import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { meetingDto, taskDto } from '../lib/serialize.js';
import { enqueueGoogleCalendarArtifacts } from '../lib/queue.js';

// Read + light-write API for meetings. The heavy ingest path (calendar
// pull + artifact watcher) lives in the worker; everything here is the
// thin layer the web UI calls to render meeting cards on a deal/contact
// page and to let the rep correct an auto-link.
//
// No create endpoint by design — meetings are only ever materialized
// from Calendar events. A "log a meeting manually" path could be added
// later but isn't part of this slice.

export const meetingsRouter = Router();
meetingsRouter.use(requireAuth);

// Common include shape — mirrors the meetingDto's expected relations.
const meetingInclude = {
  organizer: true,
  attendees: {
    include: { contact: true, user: true },
    orderBy: { id: 'asc' as const },
  },
  primaryContact: true,
  primaryDeal: { select: { id: true, title: true } },
  primaryCompany: { select: { id: true, name: true } },
} as const;

const listQuerySchema = z.object({
  dealId: z.coerce.number().int().positive().optional(),
  contactId: z.coerce.number().int().positive().optional(),
  companyId: z.coerce.number().int().positive().optional(),
  // 'all' | 'past' | 'upcoming'. Default 'all' — the deal page wants
  // both for the timeline view; the dashboard's "next meeting" widget
  // would filter to 'upcoming'.
  when: z.enum(['all', 'past', 'upcoming']).default('all'),
  // Filter to meetings that aren't firmly attached to anything yet.
  // Powers the "Connect meeting" dialog on the deal page — by default
  // the dialog only shows unlinked / suggested meetings (rare to
  // re-attach a confirmed one), with an "Show all" toggle that drops
  // this filter.
  unlinkedOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  // Free-text title search — case-insensitive substring on Meeting.title.
  // Cheap because the candidate set is small (an account's meetings
  // within the 90-day lookback).
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

meetingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const now = new Date();
    const where: import('@prisma/client').Prisma.MeetingWhereInput = {
      deletedAt: null,
    };
    if (q.dealId != null) where.primaryDealId = q.dealId;
    if (q.contactId != null) where.primaryContactId = q.contactId;
    if (q.companyId != null) where.primaryCompanyId = q.companyId;
    if (q.when === 'past') where.scheduledEnd = { lt: now };
    else if (q.when === 'upcoming') where.scheduledStart = { gte: now };
    if (q.unlinkedOnly) {
      // 'unlinked' (matcher found nothing) or 'suggested' (matcher had a
      // weak guess pending review). Confirmed/rejected stay out of the
      // dialog by default.
      where.linkStatus = { in: ['unlinked', 'suggested'] };
    }
    if (q.q) {
      where.title = { contains: q.q, mode: 'insensitive' };
    }
    const meetings = await prisma.meeting.findMany({
      where,
      include: meetingInclude,
      orderBy: { scheduledStart: 'desc' },
      take: q.limit,
    });
    res.json({ meetings: meetings.map(meetingDto) });
  }),
);

meetingsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: meetingInclude,
    });
    if (!meeting || meeting.deletedAt) throw new HttpError(404, 'Meeting not found');
    res.json({ meeting: meetingDto(meeting) });
  }),
);

const linkUpdateSchema = z
  .object({
    primaryContactId: z.number().int().positive().nullable().optional(),
    primaryDealId: z.number().int().positive().nullable().optional(),
    primaryCompanyId: z.number().int().positive().nullable().optional(),
    // Allowed transitions: confirmed (manual link or accept), rejected
    // (clear the suggested link). The matcher writes the rest; the API
    // never accepts 'unlinked' or 'suggested' from the wire because
    // those are matcher-driven states.
    linkStatus: z.enum(['confirmed', 'rejected']),
  })
  .refine(
    (d) =>
      d.linkStatus === 'rejected' ||
      d.primaryContactId != null ||
      d.primaryDealId != null ||
      d.primaryCompanyId != null,
    { message: 'A confirmed link must point at a contact, deal, or company' },
  );

// Accept-or-reject the auto-link suggestion, or set a manual link. This
// is what the meeting card's "Looks right" / "Fix this" / "Pick a deal"
// buttons hit. We re-write the audit trail with outcome=overridden so a
// later analytics pass can tune the matcher's confidence ladder.
meetingsRouter.patch(
  '/:id/link',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = linkUpdateSchema.parse(req.body);
    const meeting = await prisma.$transaction(async (tx) => {
      const existing = await tx.meeting.findUnique({ where: { id } });
      if (!existing || existing.deletedAt) throw new HttpError(404, 'Meeting not found');

      // Pull the latest audit row and mark its outcome based on the
      // direction of the user's action. Doesn't delete the row — the
      // history matters.
      const lastAudit = await tx.meetingLinkAudit.findFirst({
        where: { meetingId: id },
        orderBy: { attemptedAt: 'desc' },
      });
      if (lastAudit && body.linkStatus === 'rejected') {
        await tx.meetingLinkAudit.update({
          where: { id: lastAudit.id },
          data: { outcome: 'rejected' },
        });
      } else if (lastAudit) {
        // Confirmed via the manual flow — was the matcher right? If the
        // user picked something different, mark overridden.
        const matcherRight =
          lastAudit.chosenContactId === (body.primaryContactId ?? null) &&
          lastAudit.chosenDealId === (body.primaryDealId ?? null) &&
          lastAudit.chosenCompanyId === (body.primaryCompanyId ?? null);
        await tx.meetingLinkAudit.update({
          where: { id: lastAudit.id },
          data: { outcome: matcherRight ? 'accepted' : 'overridden' },
        });
      }

      // Hydrate missing relations from the deal when the caller only
      // supplied a dealId (the Connect Meeting dialog hits this path —
      // the rep picks a deal, we infer the contact + company). Cheaper
      // for the client than making it remember the deal's relations,
      // and keeps the matcher's invariant ("a meeting on a deal also
      // points at the deal's contact / company") intact for human-
      // driven links too.
      let primaryContactId = body.primaryContactId ?? null;
      let primaryCompanyId = body.primaryCompanyId ?? null;
      if (
        body.linkStatus === 'confirmed' &&
        body.primaryDealId != null &&
        primaryContactId == null &&
        primaryCompanyId == null
      ) {
        const deal = await tx.deal.findUnique({
          where: { id: body.primaryDealId },
          select: { primaryContactId: true, companyId: true },
        });
        if (deal) {
          primaryContactId = deal.primaryContactId;
          primaryCompanyId = deal.companyId;
        }
      }

      // For a manual confirm we record it as a fresh manual audit row
      // too — keeps the lineage clean (matcher attempt, then human
      // override). Skip on rejection to avoid log noise.
      if (body.linkStatus === 'confirmed') {
        await tx.meetingLinkAudit.create({
          data: {
            meetingId: id,
            method: 'manual',
            candidates: [],
            chosenContactId: primaryContactId,
            chosenDealId: body.primaryDealId ?? null,
            chosenCompanyId: primaryCompanyId,
            confidence: 1,
            outcome: 'accepted',
          },
        });
      }

      return tx.meeting.update({
        where: { id },
        data: {
          linkStatus: body.linkStatus,
          // When rejecting, blank the primary fields so the meeting
          // card stops claiming a wrong link. Audit row preserves the
          // history.
          primaryContactId: body.linkStatus === 'rejected' ? null : primaryContactId,
          primaryDealId: body.linkStatus === 'rejected' ? null : body.primaryDealId ?? null,
          primaryCompanyId: body.linkStatus === 'rejected' ? null : primaryCompanyId,
          linkConfidence: body.linkStatus === 'confirmed' ? 1 : null,
          linkMethod: body.linkStatus === 'confirmed' ? 'manual' : null,
          linkedAt: body.linkStatus === 'confirmed' ? new Date() : null,
          linkedByUserId: body.linkStatus === 'confirmed' ? req.user!.id : null,
        },
        include: meetingInclude,
      });
    });
    res.json({ meeting: meetingDto(meeting) });
  }),
);

// Accept / reject auto-extracted action items. These are tasks with
// status='pending_review' that came out of a Gemini summary — the rep
// confirms them (→ pending in their queue) or dismisses them
// (→ dismissed, kept for tuning signal). Editing the title/due/assignee
// before accepting goes through the regular tasks PATCH.
const taskActionSchema = z.object({
  action: z.enum(['accept', 'dismiss']),
});

meetingsRouter.post(
  '/:id/tasks/:taskId/action',
  asyncHandler(async (req, res) => {
    const meetingId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    const body = taskActionSchema.parse(req.body);
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.sourceMeetingId !== meetingId) {
      throw new HttpError(404, 'Action item not found on this meeting');
    }
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: { status: body.action === 'accept' ? 'pending' : 'dismissed' },
      include: { assignee: true, deal: { select: { id: true, title: true } } },
    });
    res.json({ task: taskDto(updated) });
  }),
);

// Manual artifact refresh. Resets the meeting's
// `artifactsProcessedAt` / `artifactsPartial` so the watcher will
// re-attempt the recording / summary / transcript fetch on its next
// run, then enqueues an immediate artifacts run for the source account
// so the rep doesn't have to wait for the cron tick. Useful when:
//   - The auto-fetch missed an artifact (Drive search couldn't match
//     the title pattern, Meet API hadn't propagated yet, etc.)
//   - A meeting was backfilled and pre-disqualified (older bug — fixed
//     but legacy rows remain)
//   - A summary / transcript was edited and we want to re-parse
meetingsRouter.post(
  '/:id/refresh-artifacts',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      select: { id: true, sourceAccountId: true, deletedAt: true },
    });
    if (!meeting || meeting.deletedAt) throw new HttpError(404, 'Meeting not found');
    if (meeting.sourceAccountId == null) {
      throw new HttpError(409, 'No connected calendar account on this meeting');
    }
    await prisma.meeting.update({
      where: { id },
      data: { artifactsProcessedAt: null, artifactsPartial: false },
    });
    await enqueueGoogleCalendarArtifacts({ googleAccountId: meeting.sourceAccountId });
    res.json({ enqueued: true });
  }),
);

// Pending-review action-items inbox for a deal. Used by the deal page's
// "Action items from meetings — needs review" panel. Returns tasks the
// rep should triage; cleanly excludes the regular task queue.
meetingsRouter.get(
  '/inbox/by-deal/:dealId',
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.dealId);
    const tasks = await prisma.task.findMany({
      where: {
        dealId,
        status: 'pending_review',
        sourceMeetingId: { not: null },
      },
      include: { assignee: true, deal: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ tasks: tasks.map(taskDto) });
  }),
);
