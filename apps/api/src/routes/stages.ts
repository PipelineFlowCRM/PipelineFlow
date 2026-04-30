import { Router } from 'express';
import { stageSchema, stagesReorderSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { stageDto } from '../lib/serialize.js';

export const stagesRouter = Router();
stagesRouter.use(requireAuth);

stagesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });
    res.json({ stages: stages.map(stageDto) });
  }),
);

stagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = stageSchema.parse(req.body);
    const stage = await prisma.pipelineStage.create({ data: input });
    res.status(201).json({ stage: stageDto(stage) });
  }),
);

stagesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = stageSchema.partial().parse(req.body);
    const stage = await prisma.pipelineStage.update({ where: { id }, data: input });
    res.json({ stage: stageDto(stage) });
  }),
);

stagesRouter.post(
  '/reorder',
  asyncHandler(async (req, res) => {
    const { ids } = stagesReorderSchema.parse(req.body);
    await prisma.$transaction(
      ids.map((id, idx) =>
        prisma.pipelineStage.update({ where: { id }, data: { order: idx + 1 } }),
      ),
    );
    res.json({ ok: true });
  }),
);

stagesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.pipelineStage.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
