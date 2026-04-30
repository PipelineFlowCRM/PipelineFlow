import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  customFieldDefinitionCreateSchema,
  customFieldDefinitionUpdateSchema,
  customFieldsReorderSchema,
  CUSTOM_FIELD_ENTITIES,
  type CustomFieldEntity,
} from '@pipelineflow/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { customFieldDefinitionDto } from '../lib/customFields.js';

export const customFieldsRouter = Router();
customFieldsRouter.use(requireAuth);

const listQuerySchema = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  includeInactive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

customFieldsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { entity, includeInactive } = listQuerySchema.parse(req.query);
    const where: Prisma.CustomFieldDefinitionWhereInput = {
      ...(entity ? { entityType: entity } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    };
    const defs = await prisma.customFieldDefinition.findMany({
      where,
      include: { _count: { select: { values: true } } },
      orderBy: [{ entityType: 'asc' }, { order: 'asc' }, { id: 'asc' }],
    });
    res.json({ definitions: defs.map(customFieldDefinitionDto) });
  }),
);

customFieldsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = customFieldDefinitionCreateSchema.parse(req.body);

    // Pin order to the end of the entity's list when not explicitly provided.
    const order =
      input.order ??
      ((
        await prisma.customFieldDefinition.aggregate({
          where: { entityType: input.entityType },
          _max: { order: true },
        })
      )._max.order ?? -1) + 1;

    try {
      const def = await prisma.customFieldDefinition.create({
        data: {
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          type: input.type,
          isRequired: input.isRequired,
          defaultValue: input.defaultValue ?? null,
          options: (input.options ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          order,
        },
        include: { _count: { select: { values: true } } },
      });
      res.status(201).json({ definition: customFieldDefinitionDto(def) });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new HttpError(409, `A field with key '${input.key}' already exists for ${input.entityType}`);
      }
      throw e;
    }
  }),
);

customFieldsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = customFieldDefinitionUpdateSchema.parse(req.body);

    // Wrap the option-narrowing check + write together so a concurrent value
    // insert using a soon-to-be-removed option key can't slip in.
    const def = await prisma.$transaction(async (tx) => {
      const existing = await tx.customFieldDefinition.findUnique({ where: { id } });
      if (!existing) throw new HttpError(404, 'Field not found');

      const isSelectType = existing.type === 'SELECT' || existing.type === 'MULTI_SELECT';
      if (input.options !== undefined && isSelectType) {
        const newChoices = input.options?.choices ?? [];
        // Reject leaving a select with zero choices — the field would accept
        // no values and there's no clear UI recovery.
        if (newChoices.length === 0) {
          throw new HttpError(400, 'Select fields must have at least one option');
        }
        // Disallow narrowing select options that already have stored values
        // not in the new list — would orphan data. Adding options is fine.
        const newKeys = new Set(newChoices.map((c) => c.value));
        const rows = await tx.customFieldValue.findMany({
          where: { definitionId: id },
          select: { valueText: true, valueJson: true },
        });
        const stored = new Set<string>();
        for (const r of rows) {
          if (r.valueText) stored.add(r.valueText);
          if (Array.isArray(r.valueJson)) for (const v of r.valueJson as string[]) stored.add(v);
        }
        for (const v of stored) {
          if (!newKeys.has(v)) {
            throw new HttpError(409, `Cannot remove option '${v}' — it is in use. Inactivate it on records first.`);
          }
        }
      }

      const data: Prisma.CustomFieldDefinitionUpdateInput = {};
      if (input.label !== undefined) data.label = input.label;
      if (input.isActive !== undefined) data.isActive = input.isActive;
      if (input.isRequired !== undefined) data.isRequired = input.isRequired;
      if (input.defaultValue !== undefined) data.defaultValue = input.defaultValue;
      if (input.options !== undefined) {
        data.options = (input.options ?? Prisma.JsonNull) as Prisma.InputJsonValue;
      }
      if (input.order !== undefined) data.order = input.order;

      return tx.customFieldDefinition.update({
        where: { id },
        data,
        include: { _count: { select: { values: true } } },
      });
    });
    res.json({ definition: customFieldDefinitionDto(def) });
  }),
);

customFieldsRouter.post(
  '/reorder',
  asyncHandler(async (req, res) => {
    const { entityType, ids } = customFieldsReorderSchema.parse(req.body);
    // Sanity-check: every id belongs to this entityType.
    const owned = await prisma.customFieldDefinition.findMany({
      where: { id: { in: ids }, entityType },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new HttpError(400, 'Some ids do not belong to the specified entityType');
    }
    await prisma.$transaction(
      ids.map((id, idx) =>
        prisma.customFieldDefinition.update({ where: { id }, data: { order: idx } }),
      ),
    );
    res.json({ ok: true });
  }),
);

customFieldsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.customFieldDefinition.findUnique({
      where: { id },
      include: { _count: { select: { values: true } } },
    });
    if (!existing) throw new HttpError(404, 'Field not found');

    if ((existing._count?.values ?? 0) > 0) {
      throw new HttpError(
        409,
        'This field has values on existing records and cannot be deleted. Inactivate it instead.',
      );
    }
    await prisma.customFieldDefinition.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
