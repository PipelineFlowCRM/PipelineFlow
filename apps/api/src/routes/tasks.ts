import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  taskCreateSchema,
  taskUpdateSchema,
  tasksListQuerySchema,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { taskDto } from '../lib/serialize.js';
import { emitWebhookEvent, emitWithSnapshot } from '../lib/webhooks.js';
import { snapshotTaskById } from '../lib/webhookSnapshots.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const taskInclude = { deal: true, assignee: true } satisfies Prisma.TaskInclude;

tasksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = tasksListQuerySchema.parse(req.query);
    const start = q.start ? new Date(q.start) : undefined;
    const end = q.end ? new Date(q.end) : undefined;
    const where: Prisma.TaskWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.dealId ? { dealId: q.dealId } : {}),
      ...(q.mine ? { assignedTo: req.user!.id } : {}),
      ...(start || end
        ? { dueDate: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } }
        : {}),
    };
    const tasks = await prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ tasks: tasks.map(taskDto) });
  }),
);

tasksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = taskCreateSchema.parse(req.body);
    const data: Prisma.TaskCreateInput = {
      title: input.title,
      description: input.description ?? null,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      ...(input.dealId ? { deal: { connect: { id: input.dealId } } } : {}),
      assignee: { connect: { id: input.assignedTo ?? req.user!.id } },
    };
    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.task.create({ data, include: taskInclude });
      if (created.dealId) {
        await tx.activity.create({
          data: {
            dealId: created.dealId,
            kind: 'task_added',
            summary: `Added task "${created.title}"`,
            actorId: req.user!.id,
          },
        });
      }
      return created;
    });
    await emitWithSnapshot('task.created', () => snapshotTaskById(task.id));
    res.status(201).json({ task: taskDto(task) });
  }),
);

tasksRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = taskUpdateSchema.parse(req.body);
    // Read pre-state so we know whether status flipped to completed; we
    // emit `task.completed` only on the transition (idempotent re-saves
    // shouldn't keep firing it).
    const before = await prisma.task.findUnique({
      where: { id }, select: { status: true },
    });
    if (!before) throw new HttpError(404, 'Task not found');
    const data: Prisma.TaskUpdateInput = {};
    if (input.title != null) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if ('dueDate' in input)
      data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (input.dealId !== undefined)
      data.deal = input.dealId ? { connect: { id: input.dealId } } : { disconnect: true };
    if (input.assignedTo !== undefined)
      data.assignee = input.assignedTo ? { connect: { id: input.assignedTo } } : { disconnect: true };
    if (input.status != null) {
      data.status = input.status;
      data.completedAt = input.status === 'completed' ? new Date() : null;
    }
    const task = await prisma.task.update({ where: { id }, data, include: taskInclude });
    const justCompleted = before.status !== 'completed' && task.status === 'completed';
    const snap = await snapshotTaskById(task.id);
    if (snap) {
      await emitWebhookEvent({ eventType: 'task.updated', data: snap });
      if (justCompleted) {
        await emitWebhookEvent({ eventType: 'task.completed', data: snap });
      }
    }
    res.json({ task: taskDto(task) });
  }),
);

tasksRouter.post(
  '/:id/toggle',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const txOut = await prisma.$transaction(async (tx) => {
      const t = await tx.task.findUnique({ where: { id } });
      if (!t) throw new HttpError(404, 'Task not found');
      const next = t.status === 'completed' ? 'pending' : 'completed';
      const updated = await tx.task.update({
        where: { id },
        data: { status: next, completedAt: next === 'completed' ? new Date() : null },
        include: taskInclude,
      });
      if (updated.dealId && next === 'completed') {
        await tx.activity.create({
          data: {
            dealId: updated.dealId,
            kind: 'task_completed',
            summary: `Completed task "${updated.title}"`,
            actorId: req.user!.id,
          },
        });
      }
      return { updated, justCompleted: next === 'completed' };
    });
    const snap = await snapshotTaskById(txOut.updated.id);
    if (snap) {
      await emitWebhookEvent({ eventType: 'task.updated', data: snap });
      if (txOut.justCompleted) {
        await emitWebhookEvent({ eventType: 'task.completed', data: snap });
      }
    }
    res.json({ task: taskDto(txOut.updated) });
  }),
);

tasksRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const snap = await snapshotTaskById(id);
    await prisma.task.delete({ where: { id } });
    if (snap) {
      await emitWebhookEvent({
        eventType: 'task.deleted',
        data: { id, snapshot: snap },
      });
    }
    res.json({ ok: true });
  }),
);
