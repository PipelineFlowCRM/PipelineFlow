import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { companyCreateSchema, companyUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { companyDto, contactDto, dealDto } from '../lib/serialize.js';
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

export const companiesRouter = Router();
companiesRouter.use(requireAuth);

companiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const filters = parseFiltersQueryParam(req.query.filters);
    const { builtin, cf } = splitFilters(filters);
    const cfAllowed = await applyCustomFieldFilters('COMPANY', cf);
    if (cfAllowed != null && cfAllowed.length === 0) {
      res.json({ companies: [] });
      return;
    }
    const builtinWhere = buildBuiltinWhere<Prisma.CompanyWhereInput>('COMPANY', builtin);
    const where: Prisma.CompanyWhereInput = {
      ...builtinWhere,
      ...(cfAllowed != null ? { id: { in: cfAllowed } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };
    const companies = await prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 100,
    });
    const cfMap = await loadCustomFieldValues(
      prisma,
      'COMPANY',
      companies.map((c) => c.id),
    );
    const dtos = await Promise.all(
      companies.map(async (c) => ({
        ...(await companyDto(c)),
        customFields: cfMap.get(c.id) ?? {},
      })),
    );
    res.json({ companies: dtos });
  }),
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = companyCreateSchema.parse(req.body);
    const { customFields, ...rest } = input;
    const dup = await prisma.company.findFirst({
      where: { name: { equals: rest.name, mode: 'insensitive' } },
    });
    if (dup) {
      const cf = await loadCustomFieldValuesFor(prisma, 'COMPANY', dup.id);
      res.json({ company: { ...(await companyDto(dup)), customFields: cf }, existed: true });
      return;
    }
    try {
      const c = await prisma.$transaction(async (tx) => {
        const created = await tx.company.create({ data: rest });
        await writeCustomFieldValues(tx, 'COMPANY', created.id, customFields, {
          enforceRequired: true,
        });
        await applyCreateDefaults(tx, 'COMPANY', created.id, customFields);
        return created;
      });
      const cf = await loadCustomFieldValuesFor(prisma, 'COMPANY', c.id);
      res.status(201).json({ company: { ...(await companyDto(c)), customFields: cf } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await prisma.company.findFirst({
          where: { name: { equals: rest.name, mode: 'insensitive' } },
        });
        if (existing) {
          const cf = await loadCustomFieldValuesFor(prisma, 'COMPANY', existing.id);
          res.json({ company: { ...(await companyDto(existing)), customFields: cf }, existed: true });
          return;
        }
      }
      throw e;
    }
  }),
);

companiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        contacts: { include: { company: true }, orderBy: [{ firstName: 'asc' }] },
        deals: {
          include: { stage: true, company: true, owner: true, primaryContact: true, tags: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });
    if (!company) throw new HttpError(404, 'Company not found');
    const cf = await loadCustomFieldValuesFor(prisma, 'COMPANY', company.id);
    res.json({
      company: { ...(await companyDto(company)), customFields: cf },
      contacts: company.contacts.map(contactDto),
      deals: company.deals.map(dealDto),
    });
  }),
);

companiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = companyUpdateSchema.parse(req.body);
    const { customFields, ...rest } = input;
    const c = await prisma.$transaction(async (tx) => {
      const updated = await tx.company.update({ where: { id }, data: rest });
      if (customFields !== undefined) {
        await writeCustomFieldValues(tx, 'COMPANY', id, customFields, {
          enforceRequired: false,
        });
      }
      return updated;
    });
    const cf = await loadCustomFieldValuesFor(prisma, 'COMPANY', c.id);
    res.json({ company: { ...(await companyDto(c)), customFields: cf } });
  }),
);

companiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.$transaction(async (tx) => {
      await tx.customFieldValue.deleteMany({ where: { entityType: 'COMPANY', entityId: id } });
      await tx.company.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);
