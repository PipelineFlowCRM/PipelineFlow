import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  CUSTOM_FIELD_ENTITIES,
  listPrefsSchema,
  listPrefsUpdateSchema,
  type ListPrefs,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';

export const listPrefsRouter = Router();
listPrefsRouter.use(requireAuth);

const DEFAULT_PREFS: ListPrefs = { columns: [], filters: [] };

listPrefsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Unauthenticated');
    const entity = z.enum(CUSTOM_FIELD_ENTITIES).parse(req.query.entity);
    const row = await prisma.userListPreference.findUnique({
      where: { userId_entityType: { userId: req.user.id, entityType: entity } },
    });
    const prefs = row ? listPrefsSchema.parse(row.prefs) : DEFAULT_PREFS;
    res.json({ entityType: entity, prefs });
  }),
);

listPrefsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Unauthenticated');
    const { entityType, prefs } = listPrefsUpdateSchema.parse(req.body);
    await prisma.userListPreference.upsert({
      where: { userId_entityType: { userId: req.user.id, entityType } },
      create: {
        userId: req.user.id,
        entityType,
        prefs: prefs as unknown as Prisma.InputJsonValue,
      },
      update: { prefs: prefs as unknown as Prisma.InputJsonValue },
    });
    res.json({ ok: true });
  }),
);
