import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { csvEscape } from '../lib/csv.js';
import { loadEntityTags } from '../lib/tags.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.get(
  '/pipeline',
  asyncHandler(async (_req, res) => {
    const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });
    const deals = await prisma.deal.findMany({ include: { stage: true } });
    const data = stages.map((s) => {
      const ds = deals.filter((d) => d.stageId === s.id);
      return {
        stage: s.name,
        color: s.color,
        count: ds.length,
        amount: ds.reduce((sum, d) => sum + Number(d.amount), 0),
        weighted: ds.reduce((sum, d) => sum + Number(d.amount) * (d.probability / 100), 0),
      };
    });
    res.json({ data });
  }),
);

reportsRouter.get(
  '/win-loss',
  asyncHandler(async (_req, res) => {
    const won = await prisma.deal.count({ where: { stage: { isWon: true } } });
    const lost = await prisma.deal.count({ where: { stage: { isLost: true } } });
    const open = await prisma.deal.count({ where: { stage: { isWon: false, isLost: false } } });
    res.json({ won, lost, open });
  }),
);

reportsRouter.get(
  '/conversion',
  asyncHandler(async (_req, res) => {
    // Single grouped query instead of N counts (one per stage).
    const [stages, grouped] = await Promise.all([
      prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } }),
      prisma.deal.groupBy({ by: ['stageId'], _count: { _all: true } }),
    ]);
    const counts = new Map(grouped.map((g) => [g.stageId, g._count._all]));
    const data = stages.map((s) => ({ stage: s.name, count: counts.get(s.id) ?? 0 }));
    res.json({ data });
  }),
);

reportsRouter.get(
  '/deals.csv',
  asyncHandler(async (_req, res) => {
    const deals = await prisma.deal.findMany({
      include: {
        stage: true, company: true, owner: true, primaryContact: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const tagMap = await loadEntityTags(prisma, 'DEAL', deals.map((d) => d.id));
    const headers = [
      'Title','Amount','Currency','Stage','Probability','Expected close',
      'Company','Primary contact','Owner','Tags','Created','Updated',
    ];
    const rows = deals.map((d) => [
      d.title,
      Number(d.amount).toFixed(2),
      d.currency,
      d.stage.name,
      String(d.probability),
      d.expectedCloseDate?.toISOString().slice(0, 10) ?? '',
      d.company?.name ?? '',
      d.primaryContact ? `${d.primaryContact.firstName} ${d.primaryContact.lastName}` : '',
      d.owner?.name ?? '',
      (tagMap.get(d.id) ?? []).map((t) => t.name).join(', '),
      d.createdAt.toISOString(),
      d.updatedAt.toISOString(),
    ]);
    const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="deals.csv"');
    res.send(csv);
  }),
);
