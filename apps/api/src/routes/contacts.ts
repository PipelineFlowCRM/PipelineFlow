import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { contactCreateSchema, contactUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { contactDto, dealDto } from '../lib/serialize.js';
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
import { emitWebhookEvent, emitWithSnapshot } from '../lib/webhooks.js';
import { snapshotContactById, snapshotDealById } from '../lib/webhookSnapshots.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  companyId: z.coerce.number().int().positive().optional(),
  tagOp: z.enum(['and', 'or']).default('or'),
});

contactsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.parse({
      q: req.query.q,
      companyId: req.query.companyId,
      tagOp: req.query.tagOp,
    });
    const q = (parsed.q ?? '').trim();
    const { companyId, tagOp } = parsed;
    const tagIds = parseTagIdsQueryParam(req.query.tagIds);

    const filters = parseFiltersQueryParam(req.query.filters);
    const { builtin, cf } = splitFilters(filters);
    const cfAllowed = await applyCustomFieldFilters('CONTACT', cf);
    if (cfAllowed != null && cfAllowed.length === 0) {
      res.json({ contacts: [] });
      return;
    }
    const tagAllowed = await filterEntityIdsByTags(prisma, 'CONTACT', tagIds, tagOp);
    if (tagAllowed != null && tagAllowed.length === 0) {
      res.json({ contacts: [] });
      return;
    }
    let allowed: number[] | null = null;
    if (cfAllowed != null && tagAllowed != null) {
      const tagSet = new Set(tagAllowed);
      allowed = cfAllowed.filter((id) => tagSet.has(id));
      if (allowed.length === 0) {
        res.json({ contacts: [] });
        return;
      }
    } else if (cfAllowed != null) {
      allowed = cfAllowed;
    } else if (tagAllowed != null) {
      allowed = tagAllowed;
    }
    const builtinWhere = buildBuiltinWhere<Prisma.ContactWhereInput>('CONTACT', builtin);

    const where: Prisma.ContactWhereInput = {
      ...builtinWhere,
      ...(companyId ? { companyId } : {}),
      ...(allowed != null ? { id: { in: allowed } } : {}),
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const contacts = await prisma.contact.findMany({
      where,
      include: { company: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 100,
    });
    const ids = contacts.map((c) => c.id);
    const [cfMap, tagMap] = await Promise.all([
      loadCustomFieldValues(prisma, 'CONTACT', ids),
      loadEntityTags(prisma, 'CONTACT', ids),
    ]);
    res.json({
      contacts: contacts.map((c) => ({
        ...contactDto(c),
        tags: tagMap.get(c.id) ?? [],
        customFields: cfMap.get(c.id) ?? {},
      })),
    });
  }),
);

contactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = contactCreateSchema.parse(req.body);
    const { customFields, tagIds, ...rest } = input;
    const c = await prisma.$transaction(async (tx) => {
      const created = await tx.contact.create({
        data: rest,
        include: { company: true },
      });
      if (tagIds && tagIds.length > 0) {
        await setEntityTags(tx, 'CONTACT', created.id, tagIds);
      }
      await writeCustomFieldValues(tx, 'CONTACT', created.id, customFields, {
        enforceRequired: true,
      });
      await applyCreateDefaults(tx, 'CONTACT', created.id, customFields);
      return created;
    });
    const [cf, tags] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'CONTACT', c.id),
      loadEntityTagsFor(prisma, 'CONTACT', c.id),
    ]);
    await emitWithSnapshot('contact.created', () => snapshotContactById(c.id));
    res.status(201).json({ contact: { ...contactDto(c), tags, customFields: cf } });
  }),
);

contactsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const c = await prisma.contact.findUnique({
      where: { id },
      include: {
        company: true,
        primaryDeals: {
          include: { stage: true, company: true, owner: true, primaryContact: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });
    if (!c) throw new HttpError(404, 'Contact not found');
    const [cf, tags, dealTagMap] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'CONTACT', c.id),
      loadEntityTagsFor(prisma, 'CONTACT', c.id),
      loadEntityTags(prisma, 'DEAL', c.primaryDeals.map((d) => d.id)),
    ]);
    res.json({
      contact: { ...contactDto(c), tags, customFields: cf },
      deals: c.primaryDeals.map((d) => ({
        ...dealDto(d),
        tags: dealTagMap.get(d.id) ?? [],
      })),
    });
  }),
);

contactsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = contactUpdateSchema.parse(req.body);
    const { customFields, tagIds, ...rest } = input;
    const c = await prisma.$transaction(async (tx) => {
      const updated = await tx.contact.update({
        where: { id },
        data: rest,
        include: { company: true },
      });
      if (tagIds !== undefined) {
        await setEntityTags(tx, 'CONTACT', id, tagIds);
      }
      if (customFields !== undefined) {
        await writeCustomFieldValues(tx, 'CONTACT', id, customFields, {
          enforceRequired: false,
        });
      }
      return updated;
    });
    const [cf, tags] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'CONTACT', c.id),
      loadEntityTagsFor(prisma, 'CONTACT', c.id),
    ]);
    await emitWithSnapshot('contact.updated', () => snapshotContactById(c.id));
    res.json({ contact: { ...contactDto(c), tags, customFields: cf } });
  }),
);

contactsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const snap = await snapshotContactById(id);
    // primaryContactId on Deal is onDelete: SetNull — same cascading
    // pattern as company.delete. Notify webhook subscribers that those
    // deals just had their primaryContact field zeroed out.
    const affectedDealIds = await prisma.deal.findMany({
      where: { primaryContactId: id },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      await tx.customFieldValue.deleteMany({ where: { entityType: 'CONTACT', entityId: id } });
      await tx.tagAttachment.deleteMany({ where: { entityType: 'CONTACT', entityId: id } });
      await tx.contact.delete({ where: { id } });
    });
    if (snap) {
      await emitWebhookEvent({
        eventType: 'contact.deleted',
        data: { id, snapshot: snap },
      });
    }
    for (const { id: dealId } of affectedDealIds) {
      await emitWithSnapshot('deal.updated', () => snapshotDealById(dealId));
    }
    res.json({ ok: true });
  }),
);
