import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      res.json({ deals: [], companies: [], contacts: [] });
      return;
    }
    const [deals, companies, contacts] = await Promise.all([
      prisma.deal.findMany({
        where: { title: { contains: q, mode: 'insensitive' } },
        include: { company: true, stage: true },
        orderBy: { updatedAt: 'desc' },
        take: 6,
      }),
      prisma.company.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        orderBy: { name: 'asc' },
        take: 6,
      }),
      prisma.contact.findMany({
        where: {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        include: { company: true },
        orderBy: [{ firstName: 'asc' }],
        take: 6,
      }),
    ]);
    res.json({
      deals: deals.map((d) => ({
        id: d.id,
        title: d.title,
        subtitle: `${d.company?.name ?? '—'} · ${d.stage?.name ?? ''}`,
      })),
      companies: companies.map((c) => ({
        id: c.id, title: c.name, subtitle: c.industry ?? '',
      })),
      contacts: contacts.map((c) => ({
        id: c.id,
        title: `${c.firstName} ${c.lastName}`,
        subtitle: [c.title, c.company?.name].filter(Boolean).join(' · '),
      })),
    });
  }),
);
