import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { companyCreateSchema, companyUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { companyDto, contactDto, dealDto } from '../lib/serialize.js';

export const companiesRouter = Router();
companiesRouter.use(requireAuth);

companiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const where: Prisma.CompanyWhereInput = q
      ? { name: { contains: q, mode: 'insensitive' } }
      : {};
    const companies = await prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 100,
    });
    res.json({ companies: await Promise.all(companies.map(companyDto)) });
  }),
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = companyCreateSchema.parse(req.body);
    const dup = await prisma.company.findFirst({
      where: { name: { equals: input.name, mode: 'insensitive' } },
    });
    if (dup) {
      res.json({ company: await companyDto(dup), existed: true });
      return;
    }
    try {
      const c = await prisma.company.create({ data: input });
      res.status(201).json({ company: await companyDto(c) });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await prisma.company.findFirst({
          where: { name: { equals: input.name, mode: 'insensitive' } },
        });
        if (existing) {
          res.json({ company: await companyDto(existing), existed: true });
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
    res.json({
      company: await companyDto(company),
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
    const c = await prisma.company.update({ where: { id }, data: input });
    res.json({ company: await companyDto(c) });
  }),
);

companiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.company.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
