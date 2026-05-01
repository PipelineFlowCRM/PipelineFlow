import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { tagCreateSchema, tagUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { tagDto } from '../lib/serialize.js';
import { loadTagsWithCounts } from '../lib/tags.js';

export const tagsRouter = Router();
tagsRouter.use(requireAuth);

// Case-insensitive name lookup. The functional unique index on lower(name)
// guarantees this matches at most one row.
async function findTagByNameCI(name: string) {
  return prisma.tag.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
}

tagsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (req.query.withCounts === '1' || req.query.withCounts === 'true') {
      const tags = await loadTagsWithCounts(prisma);
      res.json({
        tags: tags.map((t) => ({ ...tagDto(t), counts: t.counts })),
      });
      return;
    }
    const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
    res.json({ tags: tags.map(tagDto) });
  }),
);

// Explicit create — no silent upsert. Returns 409 + the existing tag if the
// name collides case-insensitively. Callers (the picker, the Settings tag
// manager) recover by selecting the existing tag.
tagsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = tagCreateSchema.parse(req.body);
    const existing = await findTagByNameCI(input.name);
    if (existing) {
      res.status(409).json({ error: 'Tag already exists', tag: tagDto(existing) });
      return;
    }
    try {
      const tag = await prisma.tag.create({ data: input });
      res.status(201).json({ tag: tagDto(tag) });
    } catch (e) {
      // Race window between the find and the create — re-fetch and surface
      // the same 409 shape so clients always get a tag object back.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const racer = await findTagByNameCI(input.name);
        if (racer) {
          res.status(409).json({ error: 'Tag already exists', tag: tagDto(racer) });
          return;
        }
      }
      throw e;
    }
  }),
);

tagsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = tagUpdateSchema.parse(req.body);
    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Tag not found');

    if (input.name != null && input.name.toLowerCase() !== existing.name.toLowerCase()) {
      const conflict = await findTagByNameCI(input.name);
      if (conflict && conflict.id !== id) {
        res.status(409).json({
          error: 'A tag with that name already exists',
          tag: tagDto(conflict),
        });
        return;
      }
    }

    try {
      const tag = await prisma.tag.update({
        where: { id },
        data: {
          ...(input.name != null ? { name: input.name } : {}),
          ...(input.color != null ? { color: input.color } : {}),
        },
      });
      res.json({ tag: tagDto(tag) });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const conflict = input.name ? await findTagByNameCI(input.name) : null;
        if (conflict) {
          res.status(409).json({
            error: 'A tag with that name already exists',
            tag: tagDto(conflict),
          });
          return;
        }
      }
      throw e;
    }
  }),
);

tagsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    // The FK cascade on TagAttachment.tagId removes attachments automatically.
    await prisma.tag.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
