import { Router } from 'express';
import { noteCreateSchema, noteUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/error.js';
import { noteDto } from '../lib/serialize.js';

export const notesRouter = Router();
notesRouter.use(requireAuth);

notesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = noteCreateSchema.parse(req.body);
    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.note.create({
        data: {
          content: input.content,
          dealId: input.dealId,
          createdBy: req.user!.id,
        },
        include: { author: true },
      });
      await tx.activity.create({
        data: {
          dealId: input.dealId,
          kind: 'note_added',
          summary: 'Added a note',
          actorId: req.user!.id,
        },
      });
      return created;
    });
    res.status(201).json({ note: noteDto(note) });
  }),
);

notesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = noteUpdateSchema.parse(req.body);
    const note = await prisma.note.update({
      where: { id },
      data: { content: input.content },
      include: { author: true },
    });
    res.json({ note: noteDto(note) });
  }),
);

notesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.note.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
