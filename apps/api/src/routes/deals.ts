import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  dealCreateSchema, dealMoveSchema, dealUpdateSchema, quickLeadSchema,
  type TagDto,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import {
  activityDto, attachmentDto, dealDto, newAvatarUrlCache, noteDto, taskDto,
} from '../lib/serialize.js';
import {
  applyCreateDefaults,
  loadCustomFieldValues,
  loadCustomFieldValuesFor,
  writeCustomFieldValues,
} from '../lib/customFields.js';
import {
  applyCustomFieldFilters,
  buildBuiltinWhere,
  parseFiltersQueryParam,
  parseTagIdsQueryParam,
  splitFilters,
} from '../lib/listFilters.js';
import {
  filterEntityIdsByTags,
  loadEntityTags,
  loadEntityTagsFor,
  setEntityTags,
} from '../lib/tags.js';
import { computeDestinationOrder } from '../lib/boardOrder.js';
import { enqueueS3Cleanup } from '../lib/queue.js';
import { emitWebhookEvent, emitWithSnapshot } from '../lib/webhooks.js';
import {
  snapshotCompanyById,
  snapshotContactById,
  snapshotDealById,
  snapshotTaskById,
} from '../lib/webhookSnapshots.js';

export const dealsRouter = Router();
dealsRouter.use(requireAuth);

const dealInclude = {
  stage: true, company: true, primaryContact: true, owner: true,
} satisfies Prisma.DealInclude;

// Place a new or restaged deal above all existing deals in the destination
// stage. Uses negative integers so we never collide with the renumber-from-0
// scheme used by the move endpoint; a subsequent drag-reorder compacts back.
async function nextTopBoardOrder(tx: Prisma.TransactionClient, stageId: number) {
  const agg = await tx.deal.aggregate({ _min: { boardOrder: true }, where: { stageId } });
  const min = agg._min.boardOrder;
  return min == null ? 0 : min - 1;
}

const dealsListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  stageId: z.coerce.number().int().positive().optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  tagOp: z.enum(['and', 'or']).default('or'),
  sort: z.enum(['updated', 'amount', 'close', 'title']).default('updated'),
});

dealsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = dealsListQuerySchema.parse({
      q: req.query.q,
      stageId: req.query.stageId,
      ownerId: req.query.ownerId,
      tagOp: req.query.tagOp,
      sort: req.query.sort,
    });
    const q = (parsed.q ?? '').trim();
    const { stageId, ownerId, sort, tagOp } = parsed;
    const tagIds = parseTagIdsQueryParam(req.query.tagIds);

    const filters = parseFiltersQueryParam(req.query.filters);
    const { builtin, cf } = splitFilters(filters);
    const cfAllowed = await applyCustomFieldFilters('DEAL', cf);
    if (cfAllowed != null && cfAllowed.length === 0) {
      res.json({ deals: [], totalValue: 0 });
      return;
    }

    const tagAllowed = await filterEntityIdsByTags(prisma, 'DEAL', tagIds, tagOp);
    if (tagAllowed != null && tagAllowed.length === 0) {
      res.json({ deals: [], totalValue: 0 });
      return;
    }

    // Intersect cf and tag id constraints when both apply.
    let allowed: number[] | null = null;
    if (cfAllowed != null && tagAllowed != null) {
      const tagSet = new Set(tagAllowed);
      allowed = cfAllowed.filter((id) => tagSet.has(id));
      if (allowed.length === 0) {
        res.json({ deals: [], totalValue: 0 });
        return;
      }
    } else if (cfAllowed != null) {
      allowed = cfAllowed;
    } else if (tagAllowed != null) {
      allowed = tagAllowed;
    }

    const builtinWhere = buildBuiltinWhere<Prisma.DealWhereInput>('DEAL', builtin);

    const where: Prisma.DealWhereInput = {
      ...builtinWhere,
      ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      ...(stageId ? { stageId } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(allowed != null ? { id: { in: allowed } } : {}),
    };

    const orderBy: Prisma.DealOrderByWithRelationInput =
      sort === 'amount' ? { amount: 'desc' }
      : sort === 'close' ? { expectedCloseDate: 'asc' }
      : sort === 'title' ? { title: 'asc' }
      : { updatedAt: 'desc' };

    const deals = await prisma.deal.findMany({ where, include: dealInclude, orderBy });
    const totalValue = deals.reduce((sum, d) => sum + Number(d.amount), 0);
    const ids = deals.map((d) => d.id);
    const cfMap = await loadCustomFieldValues(prisma, 'DEAL', ids);
    const tagMap = await loadEntityTags(prisma, 'DEAL', ids);
    res.json({
      deals: deals.map((d) => ({
        ...dealDto(d),
        tags: tagMap.get(d.id) ?? [],
        customFields: cfMap.get(d.id) ?? {},
      })),
      totalValue,
    });
  }),
);

dealsRouter.get(
  '/board',
  asyncHandler(async (_req, res) => {
    const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });
    const deals = await prisma.deal.findMany({
      include: dealInclude,
      orderBy: [{ stageId: 'asc' }, { boardOrder: 'asc' }, { id: 'desc' }],
    });
    const tagMap = await loadEntityTags(prisma, 'DEAL', deals.map((d) => d.id));
    type BoardDeal = ReturnType<typeof dealDto> & { tags: TagDto[] };
    const byStage = new Map<number, BoardDeal[]>();
    for (const s of stages) byStage.set(s.id, []);
    for (const d of deals) {
      byStage.get(d.stageId)?.push({
        ...dealDto(d),
        tags: tagMap.get(d.id) ?? [],
      });
    }
    res.json({
      stages: stages.map((s) => ({
        id: s.id, name: s.name, color: s.color, order: s.order,
        isWon: s.isWon, isLost: s.isLost,
        deals: byStage.get(s.id) ?? [],
      })),
    });
  }),
);

dealsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = dealCreateSchema.parse(req.body);
    const deal = await prisma.$transaction(async (tx) => {
      const boardOrder = await nextTopBoardOrder(tx, input.stageId);
      const created = await tx.deal.create({
        data: {
          title: input.title,
          amount: new Prisma.Decimal(input.amount),
          currency: input.currency,
          probability: input.probability,
          expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
          stageId: input.stageId,
          companyId: input.companyId ?? null,
          primaryContactId: input.primaryContactId ?? null,
          ownerId: req.user!.id,
          boardOrder,
        },
        include: dealInclude,
      });
      if (input.tagIds && input.tagIds.length > 0) {
        await setEntityTags(tx, 'DEAL', created.id, input.tagIds);
      }
      await tx.activity.create({
        data: {
          dealId: created.id,
          kind: 'created',
          summary: `Deal created in ${created.stage.name}`,
          actorId: req.user!.id,
        },
      });
      await writeCustomFieldValues(tx, 'DEAL', created.id, input.customFields, {
        enforceRequired: true,
      });
      await applyCreateDefaults(tx, 'DEAL', created.id, input.customFields);
      return created;
    });
    const [cf, tags] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'DEAL', deal.id),
      loadEntityTagsFor(prisma, 'DEAL', deal.id),
    ]);
    await emitWithSnapshot('deal.created', () => snapshotDealById(deal.id));
    res.status(201).json({ deal: { ...dealDto(deal), tags, customFields: cf } });
  }),
);

dealsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const deal = await prisma.deal.findUnique({
      where: { id },
      include: {
        ...dealInclude,
        notes: {
          include: { author: true },
          orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        },
        tasks: { include: { assignee: true, deal: true }, orderBy: { dueDate: 'asc' } },
        attachments: { include: { uploader: true }, orderBy: { uploadedAt: 'desc' } },
        activities: { include: { actor: true }, orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!deal) throw new HttpError(404, 'Deal not found');
    const avatarCache = newAvatarUrlCache();
    const [cf, tags, notes, activities] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'DEAL', deal.id),
      loadEntityTagsFor(prisma, 'DEAL', deal.id),
      Promise.all(deal.notes.map((n) => noteDto(n, avatarCache))),
      Promise.all(deal.activities.map((a) => activityDto(a, avatarCache))),
    ]);
    res.json({
      deal: { ...dealDto(deal), tags, customFields: cf },
      notes,
      tasks: deal.tasks.map(taskDto),
      attachments: deal.attachments.map(attachmentDto),
      activities,
    });
  }),
);

dealsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = dealUpdateSchema.parse(req.body);
    const txOut = await prisma.$transaction(async (tx) => {
      const existing = await tx.deal.findUnique({ where: { id }, include: { stage: true } });
      if (!existing) throw new HttpError(404, 'Deal not found');

      const data: Prisma.DealUpdateInput = {};
      if (input.title != null) data.title = input.title;
      if (input.amount != null) data.amount = new Prisma.Decimal(input.amount);
      if (input.currency != null) data.currency = input.currency;
      if (input.probability != null) data.probability = input.probability;
      if ('expectedCloseDate' in input)
        data.expectedCloseDate = input.expectedCloseDate ? new Date(input.expectedCloseDate) : null;
      if (input.companyId !== undefined)
        data.company = input.companyId ? { connect: { id: input.companyId } } : { disconnect: true };
      if (input.primaryContactId !== undefined)
        data.primaryContact = input.primaryContactId
          ? { connect: { id: input.primaryContactId } }
          : { disconnect: true };

      let stageChanged = false;
      if (input.stageId != null && input.stageId !== existing.stageId) {
        data.stage = { connect: { id: input.stageId } };
        data.stageChangedAt = new Date();
        data.boardOrder = await nextTopBoardOrder(tx, input.stageId);
        stageChanged = true;
      }

      const updated = await tx.deal.update({
        where: { id }, data, include: { ...dealInclude },
      });

      if (input.tagIds !== undefined) {
        await setEntityTags(tx, 'DEAL', id, input.tagIds);
      }

      if (input.customFields !== undefined) {
        await writeCustomFieldValues(tx, 'DEAL', id, input.customFields, {
          enforceRequired: false,
        });
      }

      if (stageChanged) {
        const summary =
          updated.stage.isWon
            ? `Marked as won (${existing.stage?.name ?? '?'} → ${updated.stage.name})`
            : updated.stage.isLost
              ? `Marked as lost (${existing.stage?.name ?? '?'} → ${updated.stage.name})`
              : `Moved ${existing.stage?.name ?? '?'} → ${updated.stage.name}`;
        const kind = updated.stage.isWon ? 'deal_won'
          : updated.stage.isLost ? 'deal_lost' : 'stage_changed';
        await tx.activity.create({
          data: { dealId: updated.id, kind, summary, actorId: req.user!.id },
        });
        // Force probability + closedAt to match terminal stages.
        const terminal = updated.stage.isWon || updated.stage.isLost;
        if (terminal && !existing.stage?.isWon && !existing.stage?.isLost) {
          await tx.deal.update({
            where: { id: updated.id },
            data: {
              probability: updated.stage.isWon ? 100 : 0,
              closedAt: new Date(),
            },
          });
        } else if (!terminal && (existing.stage?.isWon || existing.stage?.isLost)) {
          // Re-opened a closed deal — clear closedAt.
          await tx.deal.update({ where: { id: updated.id }, data: { closedAt: null } });
        }
        // (won → won' / lost → lost' transitions intentionally preserve the
        // original closedAt rather than resetting it.)
      } else {
        await tx.activity.create({
          data: {
            dealId: updated.id,
            kind: 'field_updated',
            summary: 'Deal details updated',
            actorId: req.user!.id,
          },
        });
      }

      const fresh = await tx.deal.findUnique({ where: { id }, include: dealInclude });
      // Compute semantic event flags so we emit *after* the tx commits.
      // `deal.updated` always fires; the others only on a stage transition.
      const wasTerminal = !!(existing.stage?.isWon || existing.stage?.isLost);
      const isTerminal = !!(updated.stage.isWon || updated.stage.isLost);
      const enteredWon = stageChanged && updated.stage.isWon && !wasTerminal;
      const enteredLost = stageChanged && updated.stage.isLost && !wasTerminal;
      // Suppress isTerminal warning — read for symmetry.
      void isTerminal;
      return { fresh, stageChanged, enteredWon, enteredLost };
    });
    const fresh = txOut.fresh;
    const [cf, tags] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'DEAL', fresh!.id),
      loadEntityTagsFor(prisma, 'DEAL', fresh!.id),
    ]);
    // Build the snapshot once and reuse it across the (possibly multiple)
    // events fired for this update — they all describe the same post-state.
    const snap = await snapshotDealById(fresh!.id);
    if (snap) {
      await emitWebhookEvent({ eventType: 'deal.updated', data: snap });
      if (txOut.stageChanged)
        await emitWebhookEvent({ eventType: 'deal.stage_changed', data: snap });
      if (txOut.enteredWon)
        await emitWebhookEvent({ eventType: 'deal.won', data: snap });
      if (txOut.enteredLost)
        await emitWebhookEvent({ eventType: 'deal.lost', data: snap });
    }
    res.json({ deal: { ...dealDto(fresh!), tags, customFields: cf } });
  }),
);

dealsRouter.post(
  '/:id/move',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { stageId, position } = dealMoveSchema.parse(req.body);
    const txOut = await prisma.$transaction(async (tx) => {
      const existing = await tx.deal.findUnique({ where: { id }, include: { stage: true } });
      if (!existing) throw new HttpError(404, 'Deal not found');
      const newStage = await tx.pipelineStage.findUnique({ where: { id: stageId } });
      if (!newStage) throw new HttpError(400, 'Invalid stage');

      const stageChanged = existing.stageId !== stageId;
      const enteringTerminal =
        stageChanged && (newStage.isWon || newStage.isLost) &&
        !(existing.stage?.isWon || existing.stage?.isLost);
      const leavingTerminal =
        stageChanged && !(newStage.isWon || newStage.isLost) &&
        (existing.stage?.isWon || existing.stage?.isLost);

      // Build the new ordering for the destination stage. Exclude the moved
      // deal from the snapshot and re-insert it at the requested index.
      const destDeals = await tx.deal.findMany({
        where: { stageId, id: { not: id } },
        orderBy: [{ boardOrder: 'asc' }, { id: 'desc' }],
        select: { id: true },
      });
      const { targetIndex, orderedIds } = computeDestinationOrder(
        destDeals.map((d) => d.id),
        id,
        position,
      );

      const moveData: Prisma.DealUpdateInput = {
        boardOrder: targetIndex,
        ...(stageChanged
          ? {
              stage: { connect: { id: stageId } },
              stageChangedAt: new Date(),
              probability: newStage.isWon ? 100 : newStage.isLost ? 0 : existing.probability,
              ...(enteringTerminal ? { closedAt: new Date() } : {}),
              ...(leavingTerminal ? { closedAt: null } : {}),
            }
          : {}),
      };
      const moved = await tx.deal.update({ where: { id }, data: moveData, include: dealInclude });

      // Renumber the rest of the destination stage to match the new order.
      for (const [i, dealId] of orderedIds.entries()) {
        if (dealId === id) continue;
        await tx.deal.update({
          where: { id: dealId },
          data: { boardOrder: i },
        });
      }

      // When crossing stages, compact the source stage so its boardOrders stay 0..n-1.
      if (stageChanged) {
        const srcDeals = await tx.deal.findMany({
          where: { stageId: existing.stageId },
          orderBy: [{ boardOrder: 'asc' }, { id: 'desc' }],
          select: { id: true },
        });
        for (const [i, d] of srcDeals.entries()) {
          await tx.deal.update({
            where: { id: d.id },
            data: { boardOrder: i },
          });
        }

        const summary =
          newStage.isWon
            ? `Marked as won (${existing.stage?.name ?? '?'} → ${newStage.name})`
            : newStage.isLost
              ? `Marked as lost (${existing.stage?.name ?? '?'} → ${newStage.name})`
              : `Moved ${existing.stage?.name ?? '?'} → ${newStage.name}`;
        const kind = newStage.isWon ? 'deal_won' : newStage.isLost ? 'deal_lost' : 'stage_changed';
        await tx.activity.create({
          data: { dealId: id, kind, summary, actorId: req.user!.id },
        });
      }

      const wasTerminal = !!(existing.stage?.isWon || existing.stage?.isLost);
      const enteredWon = stageChanged && newStage.isWon && !wasTerminal;
      const enteredLost = stageChanged && newStage.isLost && !wasTerminal;
      return { moved, stageChanged, enteredWon, enteredLost };
    });
    const updated = txOut.moved;
    const tags = await loadEntityTagsFor(prisma, 'DEAL', updated.id);
    // A move is a write — fire `deal.updated` plus any stage-transition
    // events. Mirrors the PATCH behaviour so consumers don't have to
    // distinguish between PATCH stageId and POST /move (same semantics).
    const snap = await snapshotDealById(updated.id);
    if (snap) {
      await emitWebhookEvent({ eventType: 'deal.updated', data: snap });
      if (txOut.stageChanged)
        await emitWebhookEvent({ eventType: 'deal.stage_changed', data: snap });
      if (txOut.enteredWon)
        await emitWebhookEvent({ eventType: 'deal.won', data: snap });
      if (txOut.enteredLost)
        await emitWebhookEvent({ eventType: 'deal.lost', data: snap });
    }
    res.json({ deal: { ...dealDto(updated), tags } });
  }),
);

dealsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    // Snapshot before we delete — once the row is gone we can't rebuild
    // the relations the consumer expects on the `data` payload. Same
    // for any tasks the FK cascade is about to take with us: we capture
    // them here and emit `task.deleted` for each after the deal-delete
    // commits, so receivers tracking tasks don't end up with phantom
    // rows in their downstream system.
    const snap = await snapshotDealById(id);
    const cascadingTasks = await prisma.task.findMany({
      where: { dealId: id },
      select: { id: true },
    });
    const taskSnapshots = await Promise.all(
      cascadingTasks.map((t) => snapshotTaskById(t.id)),
    );
    // Collect S3 keys for every attachment the cascade is about to take with
    // it (deal-attached + task-attached). Read INSIDE the transaction so
    // attachments added concurrently between the read and the delete don't
    // slip through unrecorded — they'd get cascade-deleted from the DB
    // while their bucket objects orphan silently. The reconcile sweep is
    // still our safety net, but tightening the window is cheap.
    const orphanedKeys = await prisma.$transaction(async (tx) => {
      const attachments = await tx.attachment.findMany({
        where: {
          OR: [
            { dealId: id },
            { task: { dealId: id } },
          ],
        },
        select: { storedKey: true },
      });
      await tx.customFieldValue.deleteMany({ where: { entityType: 'DEAL', entityId: id } });
      await tx.tagAttachment.deleteMany({ where: { entityType: 'DEAL', entityId: id } });
      await tx.deal.delete({ where: { id } });
      return attachments.map((a) => a.storedKey);
    });
    await enqueueS3Cleanup({ keys: orphanedKeys });
    if (snap) {
      await emitWebhookEvent({
        eventType: 'deal.deleted',
        data: { id, snapshot: snap },
      });
    }
    for (const taskSnap of taskSnapshots) {
      if (!taskSnap) continue;
      await emitWebhookEvent({
        eventType: 'task.deleted',
        data: { id: taskSnap.id, snapshot: taskSnap },
      });
    }
    res.json({ ok: true });
  }),
);

dealsRouter.post(
  '/quick-lead',
  asyncHandler(async (req, res) => {
    const input = quickLeadSchema.parse(req.body);
    const companyName = input.companyName.trim();
    const out = await prisma.$transaction(async (tx) => {
      let company = await tx.company.findFirst({
        where: { name: { equals: companyName, mode: 'insensitive' } },
      });
      let companyCreated = false;
      if (!company) {
        try {
          company = await tx.company.create({
            data: { name: companyName, website: input.website?.trim() || null },
          });
          companyCreated = true;
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            // Lost a race with a concurrent create — re-fetch.
            company = await tx.company.findFirst({
              where: { name: { equals: companyName, mode: 'insensitive' } },
            });
          }
          if (!company) throw e;
        }
      } else if (input.website && !company.website) {
        company = await tx.company.update({
          where: { id: company.id },
          data: { website: input.website.trim() },
        });
      }

      let contactId: number | null = null;
      if (input.contactName?.trim()) {
        const [first, ...rest] = input.contactName.trim().split(/\s+/);
        const contact = await tx.contact.create({
          data: {
            firstName: first ?? '',
            lastName: rest.join(' ') || '—',
            email: input.contactEmail?.trim() || null,
            phone: input.contactPhone?.trim() || null,
            companyId: company.id,
          },
        });
        contactId = contact.id;
      }

      const leadStage =
        (await tx.pipelineStage.findFirst({ where: { name: 'Lead' } })) ??
        (await tx.pipelineStage.findFirst({ orderBy: { order: 'asc' } }));
      if (!leadStage) throw new HttpError(400, 'No pipeline stages defined');

      const boardOrder = await nextTopBoardOrder(tx, leadStage.id);
      const deal = await tx.deal.create({
        data: {
          title: `${company.name} Deal`,
          amount: new Prisma.Decimal(0),
          probability: 10,
          stageId: leadStage.id,
          companyId: company.id,
          primaryContactId: contactId,
          ownerId: req.user!.id,
          boardOrder,
        },
        include: dealInclude,
      });
      await tx.activity.create({
        data: {
          dealId: deal.id,
          kind: 'created',
          summary: 'Quick lead created',
          actorId: req.user!.id,
        },
      });
      return { deal, companyId: company.id, companyCreated, contactId };
    });
    // Quick-lead is a fan-out create: emit one event per new record so each
    // is routed independently. company-found-existing is intentionally not
    // a `company.updated` even when we patched the website — the user
    // didn't ask for that, and the field write is incidental to the lead
    // flow.
    if (out.companyCreated) {
      await emitWithSnapshot('company.created', () => snapshotCompanyById(out.companyId));
    }
    if (out.contactId != null) {
      await emitWithSnapshot('contact.created', () => snapshotContactById(out.contactId!));
    }
    await emitWithSnapshot('deal.created', () => snapshotDealById(out.deal.id));
    res.status(201).json({
      deal: { ...dealDto(out.deal), tags: [] },
      companyId: out.companyId,
      contactId: out.contactId,
    });
  }),
);
