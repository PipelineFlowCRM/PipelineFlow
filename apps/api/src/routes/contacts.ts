import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { contactCreateSchema, contactUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { contactDto } from '../lib/serialize.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

contactsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
    const where: Prisma.ContactWhereInput = {
      ...(companyId ? { companyId } : {}),
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
    res.json({ contacts: contacts.map(contactDto) });
  }),
);

contactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = contactCreateSchema.parse(req.body);
    const c = await prisma.contact.create({
      data: input,
      include: { company: true },
    });
    res.status(201).json({ contact: contactDto(c) });
  }),
);

contactsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const c = await prisma.contact.findUnique({ where: { id }, include: { company: true } });
    if (!c) throw new HttpError(404, 'Contact not found');
    res.json({ contact: contactDto(c) });
  }),
);

contactsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = contactUpdateSchema.parse(req.body);
    const c = await prisma.contact.update({
      where: { id },
      data: input,
      include: { company: true },
    });
    res.json({ contact: contactDto(c) });
  }),
);

contactsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.contact.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
