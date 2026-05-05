// Translates list-view filter arrays (from the URL or stored prefs) into
// Prisma where clauses + custom-field intersections.
//
// Keys come in two flavors:
//   - 'firstName', 'companyId', etc.  → built-in column on the entity
//   - 'cf:<fieldKey>'                 → CustomFieldValue lookup (intersection)

import { Prisma } from '@prisma/client';
import {
  type CustomFieldEntity,
  type CustomFieldType,
  type ListFilter,
  type ListFilterOp,
  listFilterSchema,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { HttpError } from './error.js';

export const CF_KEY_PREFIX = 'cf:';

/**
 * Parse a `tagIds` query param. Accepts a comma-separated string of positive
 * integers (`?tagIds=1,4,9`) or an array. Empty / missing → []. Used by the
 * three list endpoints alongside `tagOp` (and|or).
 */
export function parseTagIdsQueryParam(raw: unknown): number[] {
  if (raw == null || raw === '') return [];
  const parts = Array.isArray(raw)
    ? raw.flatMap((v) => String(v).split(','))
    : String(raw).split(',');
  const out: number[] = [];
  for (const part of parts) {
    const s = part.trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      throw new HttpError(400, `tagIds must be positive integers; got '${s}'`);
    }
    out.push(n);
  }
  return out;
}

/** Parse a `filters` query param. Accepts JSON-encoded string or array. */
export function parseFiltersQueryParam(raw: unknown): ListFilter[] {
  if (raw == null || raw === '') return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'filters query param is not valid JSON');
    }
  }
  if (!Array.isArray(parsed)) throw new HttpError(400, 'filters must be an array');
  return parsed.map((f) => listFilterSchema.parse(f));
}

interface SplitFilters {
  builtin: ListFilter[];
  cf: ListFilter[];
}

export function splitFilters(filters: ListFilter[]): SplitFilters {
  const builtin: ListFilter[] = [];
  const cf: ListFilter[] = [];
  for (const f of filters) {
    if (f.key.startsWith(CF_KEY_PREFIX)) cf.push(f);
    else builtin.push(f);
  }
  return { builtin, cf };
}

/**
 * Intersect entity IDs across all custom-field filters. Returns:
 *   - null  → no cf filters applied (don't constrain)
 *   - []    → cf filters applied but nothing matched (caller should short-circuit)
 *   - ids[] → matching entity IDs
 */
export async function applyCustomFieldFilters(
  entityType: CustomFieldEntity,
  cfFilters: ListFilter[],
): Promise<number[] | null> {
  if (cfFilters.length === 0) return null;

  const keys = cfFilters.map((f) => f.key.slice(CF_KEY_PREFIX.length));
  const defs = await prisma.customFieldDefinition.findMany({
    where: { entityType, key: { in: keys } },
  });
  const byKey = new Map(defs.map((d) => [d.key, d] as const));

  let intersect: Set<number> | null = null;

  for (const f of cfFilters) {
    const fieldKey = f.key.slice(CF_KEY_PREFIX.length);
    const def = byKey.get(fieldKey);
    if (!def) {
      // Unknown field → no rows can match this filter.
      return [];
    }
    const where = buildCustomFieldValueWhere(def.type, def.id, entityType, f.op, f.value);
    if (where === 'NONE') return [];
    if (where === 'ALL') {
      // No constraint — leave intersect untouched.
      continue;
    }
    const rows = await prisma.customFieldValue.findMany({
      where,
      select: { entityId: true },
    });
    const ids = new Set(rows.map((r) => r.entityId));
    intersect = intersect == null ? ids : intersectSets(intersect, ids);
    if (intersect.size === 0) return [];
  }
  return intersect == null ? null : Array.from(intersect);
}

function intersectSets<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

export type CfWhereResult = Prisma.CustomFieldValueWhereInput | 'ALL' | 'NONE';

// Pure per-type translator for cf filter clauses. Exported for unit testing;
// the runtime entry point is `applyCustomFieldFilters`.
export function buildCustomFieldValueWhere(
  type: CustomFieldType,
  definitionId: number,
  entityType: CustomFieldEntity,
  op: ListFilterOp,
  value?: ListFilter['value'],
): CfWhereResult {
  const base: Prisma.CustomFieldValueWhereInput = { definitionId, entityType };
  if (op === 'is_set') {
    return { ...base, ...notNullClauseForType(type) };
  }
  // is_not_set on a cf field is intentionally not supported: it means
  // "entity has no value row OR has a null row", which can't be expressed as
  // a single intersection clause without inverting at the caller. The FE
  // doesn't expose it for cf fields (`opsForType` omits it), so anyone
  // hitting this code path is calling the API directly.
  if (op === 'is_not_set') {
    throw new HttpError(400, `op 'is_not_set' is not supported for custom-field filters`);
  }

  // Type-specific operators.
  switch (type) {
    case 'TEXT':
    case 'LONG_TEXT':
    case 'EMAIL':
    case 'URL':
    case 'PHONE':
    case 'SELECT': {
      const v = String(value ?? '');
      switch (op) {
        case 'eq':
          return { ...base, valueText: v };
        case 'neq':
          return { ...base, valueText: { not: v } };
        case 'contains':
          return { ...base, valueText: { contains: v, mode: 'insensitive' } };
        case 'starts_with':
          return { ...base, valueText: { startsWith: v, mode: 'insensitive' } };
        case 'in': {
          const arr = Array.isArray(value) ? value : [v];
          if (arr.length === 0) return 'NONE';
          return { ...base, valueText: { in: arr } };
        }
        case 'not_in': {
          const arr = Array.isArray(value) ? value : [v];
          if (arr.length === 0) return 'ALL';
          return { ...base, valueText: { notIn: arr } };
        }
      }
      break;
    }
    case 'NUMBER':
    case 'MONEY': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw new HttpError(400, `invalid number for op ${op}`);
      const dec = new Prisma.Decimal(n);
      switch (op) {
        case 'eq': return { ...base, valueNumber: dec };
        case 'neq': return { ...base, valueNumber: { not: dec } };
        case 'gt': return { ...base, valueNumber: { gt: dec } };
        case 'gte': return { ...base, valueNumber: { gte: dec } };
        case 'lt': return { ...base, valueNumber: { lt: dec } };
        case 'lte': return { ...base, valueNumber: { lte: dec } };
      }
      break;
    }
    case 'DATE': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new HttpError(400, 'invalid date filter value');
      }
      const d = new Date(value + 'T00:00:00Z');
      switch (op) {
        case 'eq': return { ...base, valueDate: d };
        case 'gt': return { ...base, valueDate: { gt: d } };
        case 'gte': return { ...base, valueDate: { gte: d } };
        case 'lt': return { ...base, valueDate: { lt: d } };
        case 'lte': return { ...base, valueDate: { lte: d } };
      }
      break;
    }
    case 'DATETIME': {
      if (typeof value !== 'string') {
        throw new HttpError(400, 'invalid datetime filter value');
      }
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new HttpError(400, 'invalid datetime filter value');
      }
      switch (op) {
        case 'eq': return { ...base, valueDateTime: d };
        case 'gt': return { ...base, valueDateTime: { gt: d } };
        case 'gte': return { ...base, valueDateTime: { gte: d } };
        case 'lt': return { ...base, valueDateTime: { lt: d } };
        case 'lte': return { ...base, valueDateTime: { lte: d } };
      }
      break;
    }
    case 'BOOLEAN': {
      switch (op) {
        case 'is_true': return { ...base, valueBool: true };
        case 'is_false': return { ...base, valueBool: false };
        case 'eq': return { ...base, valueBool: value === true || value === 'true' };
      }
      break;
    }
    case 'MULTI_SELECT': {
      // valueJson holds string[]. Postgres JSONB array_contains supports
      // matching when the array contains the supplied value(s).
      const arr = Array.isArray(value) ? value : value != null ? [String(value)] : [];
      if (arr.length === 0) return 'ALL';
      switch (op) {
        case 'contains':
          // Match rows whose JSON array contains EVERY supplied value.
          return {
            ...base,
            AND: arr.map((v) => ({ valueJson: { array_contains: [v] } })),
          };
        case 'in':
          // Match rows whose JSON array contains ANY of the supplied values.
          return {
            ...base,
            OR: arr.map((v) => ({ valueJson: { array_contains: [v] } })),
          };
      }
      break;
    }
  }
  throw new HttpError(400, `op '${op}' not supported for type ${type}`);
}

function notNullClauseForType(type: CustomFieldType): Prisma.CustomFieldValueWhereInput {
  switch (type) {
    case 'TEXT':
    case 'LONG_TEXT':
    case 'EMAIL':
    case 'URL':
    case 'PHONE':
    case 'SELECT':
      return { valueText: { not: null } };
    case 'NUMBER':
    case 'MONEY':
      return { valueNumber: { not: null } };
    case 'DATE':
      return { valueDate: { not: null } };
    case 'DATETIME':
      return { valueDateTime: { not: null } };
    case 'BOOLEAN':
      return { valueBool: { not: null } };
    case 'MULTI_SELECT':
      return { NOT: { valueJson: { equals: Prisma.JsonNull } } };
  }
}

/**
 * Translate built-in filters into a Prisma where clause for the supplied
 * entity. Unknown keys are rejected to surface typos. Multiple filters on
 * the same key are combined via a top-level AND so each clause is enforced
 * independently.
 */
export function buildBuiltinWhere<T extends Record<string, unknown>>(
  entityType: CustomFieldEntity,
  filters: ListFilter[],
): T {
  const fieldMap = BUILTIN_FIELDS[entityType];
  // Collect every clause first; then split single-occurrence keys into
  // direct properties and duplicate-key clauses into a top-level AND.
  const perKey = new Map<string, unknown[]>();
  for (const f of filters) {
    const def = fieldMap[f.key];
    if (!def) throw new HttpError(400, `Unknown filter field '${f.key}' for ${entityType}`);
    const clause = def.build(f.op, f.value);
    if (clause === undefined) continue;
    const list = perKey.get(f.key) ?? [];
    list.push(clause);
    perKey.set(f.key, list);
  }

  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  for (const [key, clauses] of perKey) {
    if (clauses.length === 1) {
      where[key] = clauses[0];
    } else {
      for (const c of clauses) and.push({ [key]: c });
    }
  }
  if (and.length > 0) where.AND = and;
  return where as T;
}

interface BuiltinFieldDef {
  build: (op: ListFilterOp, value: ListFilter['value']) => unknown | undefined;
}

const stringField: BuiltinFieldDef = {
  build(op, value) {
    const v = String(value ?? '');
    switch (op) {
      case 'eq': return v;
      case 'neq': return { not: v };
      case 'contains': return { contains: v, mode: 'insensitive' as const };
      case 'starts_with': return { startsWith: v, mode: 'insensitive' as const };
      case 'is_set': return { not: null };
      case 'is_not_set': return null;
      case 'in': return { in: Array.isArray(value) ? value : [v] };
      case 'not_in': return { notIn: Array.isArray(value) ? value : [v] };
    }
    throw new HttpError(400, `op '${op}' not supported on string field`);
  },
};

const numberField: BuiltinFieldDef = {
  build(op, value) {
    const n = typeof value === 'number' ? value : Number(value);
    switch (op) {
      case 'eq': return n;
      case 'neq': return { not: n };
      case 'gt': return { gt: n };
      case 'gte': return { gte: n };
      case 'lt': return { lt: n };
      case 'lte': return { lte: n };
      case 'is_set': return { not: null };
      case 'is_not_set': return null;
    }
    throw new HttpError(400, `op '${op}' not supported on number field`);
  },
};

function toId(v: ListFilter['value']): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, `id filter expects a positive integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

const idField: BuiltinFieldDef = {
  build(op, value) {
    switch (op) {
      case 'eq': return toId(value);
      case 'neq': return { not: toId(value) };
      case 'in':
        return { in: (Array.isArray(value) ? value : [value]).map(toId) };
      case 'not_in':
        return { notIn: (Array.isArray(value) ? value : [value]).map(toId) };
      case 'is_set': return { not: null };
      case 'is_not_set': return null;
    }
    throw new HttpError(400, `op '${op}' not supported on id field`);
  },
};

// Allow-listed built-in filter targets per entity. Anything not listed is
// rejected with a 400 — keeps the surface tight.
const BUILTIN_FIELDS: Record<CustomFieldEntity, Record<string, BuiltinFieldDef>> = {
  CONTACT: {
    firstName: stringField,
    lastName: stringField,
    email: stringField,
    phone: stringField,
    title: stringField,
    companyId: idField,
  },
  COMPANY: {
    name: stringField,
    industry: stringField,
    size: stringField,
    city: stringField,
    state: stringField,
  },
  DEAL: {
    title: stringField,
    stageId: idField,
    companyId: idField,
    ownerId: idField,
    primaryContactId: idField,
    amount: numberField,
    probability: numberField,
  },
};
