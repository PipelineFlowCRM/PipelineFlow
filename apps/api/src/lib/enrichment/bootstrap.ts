// Idempotent bootstrap of the `last_enriched_at` company custom field.
// Called from the apply path on every successful run, and once on api boot
// when enrichment is enabled — so an operator who flips the toggle sees the
// field show up in the Custom Fields settings page immediately, not only
// after the first enrichment. Missing the bootstrap on boot is harmless;
// the next apply call creates it.

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
      // Last-known order — created via migration would otherwise sit at 0
      // and crowd the list. Pick a high default so it lands at the bottom.
      order: 1000,
    },
    select: { id: true },
  });
  return created;
}
