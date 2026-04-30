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
  splitFilters,
} from '../lib/listFilters.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  companyId: z.coerce.number().int().positive().optional(),
});

contactsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listQuerySchema.parse({
      q: req.query.q,
      companyId: req.query.companyId,
    });
    const q = (parsed.q ?? '').trim();
    const companyId = parsed.companyId;

    const filters = parseFiltersQueryParam(req.query.filters);
    const { builtin, cf } = splitFilters(filters);
    const cfAllowed = await applyCustomFieldFilters('CONTACT', cf);
    if (cfAllowed != null && cfAllowed.length === 0) {
      res.json({ contacts: [] });
      return;
    }
    const builtinWhere = buildBuiltinWhere<Prisma.ContactWhereInput>('CONTACT', builtin);

    const where: Prisma.ContactWhereInput = {
      ...builtinWhere,
      ...(companyId ? { companyId } : {}),
      ...(cfAllowed != null ? { id: { in: cfAllowed } } : {}),
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
    const cfMap = await loadCustomFieldValues(
      prisma,
      'CONTACT',
      contacts.map((c) => c.id),
    );
    res.json({
      contacts: contacts.map((c) => ({
        ...contactDto(c),
        customFields: cfMap.get(c.id) ?? {},
      })),
    });
  }),
);

contactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = contactCreateSchema.parse(req.body);
    const { customFields, ...rest } = input;
    const c = await prisma.$transaction(async (tx) => {
      const created = await tx.contact.create({
        data: rest,
        include: { company: true },
      });
      await writeCustomFieldValues(tx, 'CONTACT', created.id, customFields, {
        enforceRequired: true,
      });
      await applyCreateDefaults(tx, 'CONTACT', created.id, customFields);
      return created;
    });
    const cf = await loadCustomFieldValuesFor(prisma, 'CONTACT', c.id);
    res.status(201).json({ contact: { ...contactDto(c), customFields: cf } });
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
          include: { stage: true, company: true, owner: true, primaryContact: true, tags: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });
    if (!c) throw new HttpError(404, 'Contact not found');
    const cf = await loadCustomFieldValuesFor(prisma, 'CONTACT', c.id);
    res.json({
      contact: { ...contactDto(c), customFields: cf },
      deals: c.primaryDeals.map(dealDto),
    });
  }),
);

contactsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = contactUpdateSchema.parse(req.body);
    const { customFields, ...rest } = input;
    const c = await prisma.$transaction(async (tx) => {
      const updated = await tx.contact.update({
        where: { id },
        data: rest,
        include: { company: true },
      });
      if (customFields !== undefined) {
        await writeCustomFieldValues(tx, 'CONTACT', id, customFields, {
          enforceRequired: false,
        });
      }
      return updated;
    });
    const cf = await loadCustomFieldValuesFor(prisma, 'CONTACT', c.id);
    res.json({ contact: { ...contactDto(c), customFields: cf } });
  }),
);

contactsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.$transaction(async (tx) => {
      await tx.customFieldValue.deleteMany({ where: { entityType: 'CONTACT', entityId: id } });
      await tx.contact.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);
