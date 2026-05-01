import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { activityDto, dealDto, taskDto } from '../lib/serialize.js';
import { loadEntityTags } from '../lib/tags.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });
    const deals = await prisma.deal.findMany({
      include: { stage: true, company: true, owner: true, primaryContact: true },
    });

    const open = deals.filter((d) => !d.stage.isWon && !d.stage.isLost);
    const won = deals.filter((d) => d.stage.isWon);
    const lost = deals.filter((d) => d.stage.isLost);

    const byStage = stages.map((s) => {
      const ds = deals.filter((d) => d.stageId === s.id);
      return {
        id: s.id, name: s.name, color: s.color,
        count: ds.length,
        amount: ds.reduce((sum, d) => sum + Number(d.amount), 0),
      };
    });

    const overdueTasks = await prisma.task.findMany({
      where: {
        status: 'pending',
        dueDate: { lt: new Date() },
      },
      include: { deal: true, assignee: true },
      orderBy: { dueDate: 'asc' },
      take: 8,
    });

    const myTasks = await prisma.task.findMany({
      where: { assignedTo: userId, status: 'pending' },
      include: { deal: true, assignee: true },
      orderBy: { dueDate: 'asc' },
      take: 8,
    });

    const recent = await prisma.activity.findMany({
      include: { actor: true },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });

    const recentDeals = await prisma.deal.findMany({
      include: { stage: true, company: true, owner: true, primaryContact: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });
    const recentTagMap = await loadEntityTags(prisma, 'DEAL', recentDeals.map((d) => d.id));

    res.json({
      kpis: {
        openCount: open.length,
        openValue: open.reduce((s, d) => s + Number(d.amount), 0),
        weightedValue: open.reduce((s, d) => s + Number(d.amount) * (d.probability / 100), 0),
        wonCount: won.length,
        wonValue: won.reduce((s, d) => s + Number(d.amount), 0),
        lostCount: lost.length,
        winRate:
          won.length + lost.length === 0
            ? 0
            : won.length / (won.length + lost.length),
      },
      byStage,
      overdueTasks: overdueTasks.map(taskDto),
      myTasks: myTasks.map(taskDto),
      recentActivity: recent.map(activityDto),
      recentDeals: recentDeals.map((d) => ({
        ...dealDto(d),
        tags: recentTagMap.get(d.id) ?? [],
      })),
    });
  }),
);
