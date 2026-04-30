import { Router } from 'express';
import { tagSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { tagDto } from '../lib/serialize.js';

export const tagsRouter = Router();
tagsRouter.use(requireAuth);

tagsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
    res.json({ tags: tags.map(tagDto) });
  }),
);

tagsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = tagSchema.parse(req.body);
    const tag = await prisma.tag.upsert({
      where: { name: input.name },
      update: { color: input.color },
      create: input,
    });
    res.json({ tag: tagDto(tag) });
  }),
);

tagsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.tag.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
