// Helpers for reading + writing tag attachments. Mirrors the shape of
// customFields helpers (loadCustomFieldValues / writeCustomFieldValues) so
// callers can reuse the same composition pattern.
//
// Tags are polymorphic via (entityType, entityId). There's no FK on entityId,
// so each entity DELETE handler must clean up its rows explicitly — same
// precedent as CustomFieldValue.

import { Prisma, type Tag } from '@prisma/client';
import { type CustomFieldEntity } from '@pipelineflow/shared';
import { HttpError } from './error.js';
import { tagDto } from './serialize.js';

type TagDtoShape = ReturnType<typeof tagDto>;

/**
 * Replace the exact set of tags attached to (entityType, entityId) with the
 * supplied tagIds. Idempotent. Validates that all tagIds exist (404 if not).
 */
export async function setEntityTags(
  tx: Prisma.TransactionClient,
  entityType: CustomFieldEntity,
  entityId: number,
  tagIds: number[],
): Promise<void> {
  const wanted = Array.from(new Set(tagIds));

  if (wanted.length > 0) {
    const found = await tx.tag.findMany({
      where: { id: { in: wanted } },
      select: { id: true },
    });
    if (found.length !== wanted.length) {
      throw new HttpError(404, 'One or more tagIds do not exist');
    }
  }

  const existing = await tx.tagAttachment.findMany({
    where: { entityType, entityId },
    select: { tagId: true },
  });
  const existingIds = new Set(existing.map((r) => r.tagId));
  const wantedSet = new Set(wanted);

  const toAdd = wanted.filter((id) => !existingIds.has(id));
  const toRemove = [...existingIds].filter((id) => !wantedSet.has(id));

  if (toRemove.length > 0) {
    await tx.tagAttachment.deleteMany({
      where: { entityType, entityId, tagId: { in: toRemove } },
    });
  }
  if (toAdd.length > 0) {
    await tx.tagAttachment.createMany({
      data: toAdd.map((tagId) => ({ tagId, entityType, entityId })),
      skipDuplicates: true,
    });
  }
}

/**
 * Hydrate tags for a list of entities of the same type. Returns a map keyed
 * by entityId. Entity ids with no attachments are present in the map with an
 * empty array (callers can assume `map.get(id)` is never undefined for an id
 * they passed in).
 */
export async function loadEntityTags(
  client: Prisma.TransactionClient | typeof import('../db.js').prisma,
  entityType: CustomFieldEntity,
  entityIds: number[],
): Promise<Map<number, TagDtoShape[]>> {
  const out = new Map<number, TagDtoShape[]>();
  for (const id of entityIds) out.set(id, []);
  if (entityIds.length === 0) return out;

  const rows = await client.tagAttachment.findMany({
    where: { entityType, entityId: { in: entityIds } },
    include: { tag: true },
    orderBy: { tag: { name: 'asc' } },
  });
  for (const row of rows) {
    out.get(row.entityId)?.push(tagDto(row.tag));
  }
  return out;
}

/** Single-entity convenience wrapper. */
export async function loadEntityTagsFor(
  client: Prisma.TransactionClient | typeof import('../db.js').prisma,
  entityType: CustomFieldEntity,
  entityId: number,
): Promise<TagDtoShape[]> {
  const m = await loadEntityTags(client, entityType, [entityId]);
  return m.get(entityId) ?? [];
}

/**
 * For a list of entity ids, return only the ids that have a TagAttachment
 * matching the supplied tagIds and operator. Used by list filters.
 *
 *   op === 'or'  → entity has ANY of the supplied tags
 *   op === 'and' → entity has EVERY supplied tag
 *
 * Returns null when tagIds is empty (caller should not constrain).
 */
export async function filterEntityIdsByTags(
  client: Prisma.TransactionClient | typeof import('../db.js').prisma,
  entityType: CustomFieldEntity,
  tagIds: number[],
  op: 'and' | 'or',
): Promise<number[] | null> {
  const ids = Array.from(new Set(tagIds));
  if (ids.length === 0) return null;

  const rows = await client.tagAttachment.findMany({
    where: { entityType, tagId: { in: ids } },
    select: { entityId: true, tagId: true },
  });

  if (op === 'or') {
    return Array.from(new Set(rows.map((r) => r.entityId)));
  }

  // AND — entity must match every supplied tag id.
  const counts = new Map<number, Set<number>>();
  for (const r of rows) {
    let s = counts.get(r.entityId);
    if (!s) {
      s = new Set();
      counts.set(r.entityId, s);
    }
    s.add(r.tagId);
  }
  const out: number[] = [];
  for (const [entityId, tagSet] of counts) {
    if (tagSet.size === ids.length) out.push(entityId);
  }
  return out;
}

export type TagWithCounts = Tag & {
  counts: { deals: number; companies: number; contacts: number; total: number };
};

/**
 * Load tags with usage counts per entity type. Drives the Settings tag
 * manager and the delete-confirm dialog. Skipped by the picker (which
 * doesn't need counts on its hot path).
 */
export async function loadTagsWithCounts(
  client: Prisma.TransactionClient | typeof import('../db.js').prisma,
): Promise<TagWithCounts[]> {
  const tags = await client.tag.findMany({ orderBy: { name: 'asc' } });
  if (tags.length === 0) return [];

  const grouped = await client.tagAttachment.groupBy({
    by: ['tagId', 'entityType'],
    _count: { _all: true },
  });

  const byTag = new Map<number, TagWithCounts['counts']>();
  for (const t of tags) {
    byTag.set(t.id, { deals: 0, companies: 0, contacts: 0, total: 0 });
  }
  for (const g of grouped) {
    const entry = byTag.get(g.tagId);
    if (!entry) continue;
    const n = g._count._all;
    if (g.entityType === 'DEAL') entry.deals += n;
    else if (g.entityType === 'COMPANY') entry.companies += n;
    else if (g.entityType === 'CONTACT') entry.contacts += n;
    entry.total += n;
  }
  return tags.map((t) => ({ ...t, counts: byTag.get(t.id)! }));
}
