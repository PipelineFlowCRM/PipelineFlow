// Worker-side bootstrap of the `last_enriched_at` company custom field.
// Mirrors apps/api/src/lib/enrichment/bootstrap.ts — duplicated to keep the
// worker's prisma client local. Idempotent; safe to call inside the apply
// transaction.

import type { Prisma, PrismaClient } from '@prisma/client';
import { ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY } from '@pipelineflow/shared';

type Tx = PrismaClient | Prisma.TransactionClient;

export async function ensureLastEnrichedAtField(tx: Tx): Promise<{ id: number }> {
  const existing = await tx.customFieldDefinition.findUnique({
    where: {
      entityType_key: {
        entityType: 'COMPANY',
        key: ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY,
      },
    },
    select: { id: true },
  });
  if (existing) return existing;
  const created = await tx.customFieldDefinition.create({
    data: {
      entityType: 'COMPANY',
      key: ENRICHMENT_LAST_RUN_CUSTOM_FIELD_KEY,
      label: 'Last enriched at',
      type: 'DATETIME',
      isActive: true,
      isRequired: false,
      order: 1000,
    },
    select: { id: true },
  });
  return created;
}
