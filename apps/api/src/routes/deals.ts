import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  dealCreateSchema, dealMoveSchema, dealUpdateSchema, quickLeadSchema,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import {
  activityDto, attachmentDto, dealDto, noteDto, taskDto,
} from '../lib/serialize.js';

export const dealsRouter = Router();
dealsRouter.use(requireAuth);

const dealInclude = {
  stage: true, company: true, primaryContact: true, owner: true, tags: true,
} satisfies Prisma.DealInclude;

async function resolveTags(tx: Prisma.TransactionClient, names: string[]) {
  if (!names.length) return [];
  return Promise.all(
    names.map((name) =>
      tx.tag.upsert({ where: { name }, update: {}, create: { name } }),
    ),
  );
}

dealsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const stageId = req.query.stageId ? Number(req.query.stageId) : undefined;
    const ownerId = req.query.ownerId ? Number(req.query.ownerId) : undefined;
    const tagName = req.query.tag ? String(req.query.tag) : undefined;
    const sort = String(req.query.sort ?? 'updated');

    const where: Prisma.DealWhereInput = {
      ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      ...(stageId ? { stageId } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(tagName ? { tags: { some: { name: tagName } } } : {}),
    };

    const orderBy: Prisma.DealOrderByWithRelationInput =
      sort === 'amount' ? { amount: 'desc' }
      : sort === 'close' ? { expectedCloseDate: 'asc' }
      : sort === 'title' ? { title: 'asc' }
      : { updatedAt: 'desc' };

    const deals = await prisma.deal.findMany({ where, include: dealInclude, orderBy });
    const totalValue = deals.reduce((sum, d) => sum + Number(d.amount), 0);
    res.json({ deals: deals.map(dealDto), totalValue });
  }),
);

dealsRouter.get(
  '/board',
  asyncHandler(async (_req, res) => {
    const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });
    const deals = await prisma.deal.findMany({
      include: dealInclude,
      orderBy: { updatedAt: 'desc' },
    });
    const byStage = new Map<number, ReturnType<typeof dealDto>[]>();
    for (const s of stages) byStage.set(s.id, []);
    for (const d of deals) byStage.get(d.stageId)?.push(dealDto(d));
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
      const tags = await resolveTags(tx, input.tagNames);
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
          tags: { connect: tags.map((t) => ({ id: t.id })) },
        },
        include: dealInclude,
      });
      await tx.activity.create({
        data: {
          dealId: created.id,
          kind: 'created',
          summary: `Deal created in ${created.stage.name}`,
          actorId: req.user!.id,
        },
      });
      return created;
    });
    res.status(201).json({ deal: dealDto(deal) });
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
        notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
        tasks: { include: { assignee: true, deal: true }, orderBy: { dueDate: 'asc' } },
        attachments: { include: { uploader: true }, orderBy: { uploadedAt: 'desc' } },
        activities: { include: { actor: true }, orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!deal) throw new HttpError(404, 'Deal not found');
    res.json({
      deal: dealDto(deal),
      notes: deal.notes.map(noteDto),
      tasks: deal.tasks.map(taskDto),
      attachments: deal.attachments.map(attachmentDto),
      activities: deal.activities.map(activityDto),
    });
  }),
);

dealsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = dealUpdateSchema.parse(req.body);
    const fresh = await prisma.$transaction(async (tx) => {
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
        stageChanged = true;
      }

      if (input.tagNames) {
        const tags = await resolveTags(tx, input.tagNames);
        data.tags = { set: tags.map((t) => ({ id: t.id })) };
      }

      const updated = await tx.deal.update({
        where: { id }, data, include: { ...dealInclude },
      });

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

      return tx.deal.findUnique({ where: { id }, include: dealInclude });
    });
    res.json({ deal: dealDto(fresh!) });
  }),
);

dealsRouter.post(
  '/:id/move',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { stageId } = dealMoveSchema.parse(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.deal.findUnique({ where: { id }, include: { stage: true } });
      if (!existing) throw new HttpError(404, 'Deal not found');
      if (existing.stageId === stageId) {
        return tx.deal.findUnique({ where: { id }, include: dealInclude });
      }
      const newStage = await tx.pipelineStage.findUnique({ where: { id: stageId } });
      if (!newStage) throw new HttpError(400, 'Invalid stage');

      const enteringTerminal =
        (newStage.isWon || newStage.isLost) && !(existing.stage?.isWon || existing.stage?.isLost);
      const leavingTerminal =
        !(newStage.isWon || newStage.isLost) && (existing.stage?.isWon || existing.stage?.isLost);

      const data: Prisma.DealUpdateInput = {
        stage: { connect: { id: stageId } },
        stageChangedAt: new Date(),
        probability: newStage.isWon ? 100 : newStage.isLost ? 0 : existing.probability,
        ...(enteringTerminal ? { closedAt: new Date() } : {}),
        ...(leavingTerminal ? { closedAt: null } : {}),
      };
      const moved = await tx.deal.update({ where: { id }, data, include: dealInclude });
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
      return moved;
    });
    res.json({ deal: dealDto(updated!) });
  }),
);

dealsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.deal.delete({ where: { id } });
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
      if (!company) {
        try {
          company = await tx.company.create({
            data: { name: companyName, website: input.website?.trim() || null },
          });
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

      const deal = await tx.deal.create({
        data: {
          title: `${company.name} Deal`,
          amount: new Prisma.Decimal(0),
          probability: 10,
          stageId: leadStage.id,
          companyId: company.id,
          primaryContactId: contactId,
          ownerId: req.user!.id,
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
      return { deal, companyId: company.id, contactId };
    });
    res.status(201).json({
      deal: dealDto(out.deal),
      companyId: out.companyId,
      contactId: out.contactId,
    });
  }),
);
