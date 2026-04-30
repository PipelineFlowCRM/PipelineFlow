// Helpers for reading, writing, and validating custom-field values.
//
// The shape stored in the DB depends on the field's `type` — exactly one of
// (valueText, valueNumber, valueDate, valueBool, valueJson) is populated per
// row. These helpers funnel JSON-friendly inputs into the right column and
// flatten DB rows back into a {key: value} map for entity DTOs.

import { Prisma, type CustomFieldDefinition, type CustomFieldValue } from '@prisma/client';
import {
  type CustomFieldEntity,
  type CustomFieldOptionsConfig,
  type CustomFieldType,
  type CustomFieldValuesMap,
  type CustomFieldValuesPayload,
  type CustomFieldDefinitionDto,
} from '@pipelineflow/shared';
import { HttpError } from './error.js';
import { logger } from './logger.js';

type AnyValue = string | number | boolean | string[] | null;

/** Per-type column write payload for a single value row. */
export interface ValueColumns {
  valueText: string | null;
  valueNumber: Prisma.Decimal | null;
  valueDate: Date | null;
  valueBool: boolean | null;
  valueJson: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

const EMPTY_COLUMNS: ValueColumns = {
  valueText: null,
  valueNumber: null,
  valueDate: null,
  valueBool: null,
  valueJson: Prisma.JsonNull,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getOptionsConfig(def: { options: unknown }): CustomFieldOptionsConfig | null {
  // Prisma returns Json as `JsonValue`; we trust validation already happened
  // at write-time via Zod.
  return (def.options as CustomFieldOptionsConfig) ?? null;
}

function selectValueKeys(def: { options: unknown }): Set<string> {
  const opts = getOptionsConfig(def);
  return new Set((opts?.choices ?? []).map((c) => c.value));
}

/**
 * Validate + coerce a payload value against a field definition.
 * Throws HttpError(400) on invalid input. Returns the typed columns to
 * write — or `null` to delete the value row entirely (when input is null/empty).
 */
export function coerceValue(
  def: { key: string; type: CustomFieldType; options: unknown },
  raw: AnyValue | undefined,
): ValueColumns | null {
  const isNullish = raw === undefined || raw === null || raw === '';

  switch (def.type) {
    case 'TEXT':
    case 'LONG_TEXT': {
      if (isNullish) return null;
      if (typeof raw !== 'string') throw bad(def.key, 'must be a string');
      const v = raw.trim();
      if (!v) return null;
      if (def.type === 'TEXT' && v.length > 500) throw bad(def.key, 'too long (max 500)');
      if (def.type === 'LONG_TEXT' && v.length > 10_000) throw bad(def.key, 'too long (max 10000)');
      return { ...EMPTY_COLUMNS, valueText: v };
    }
    case 'EMAIL': {
      if (isNullish) return null;
      if (typeof raw !== 'string') throw bad(def.key, 'must be a string');
      const v = raw.trim();
      if (!EMAIL_RE.test(v)) throw bad(def.key, 'invalid email');
      return { ...EMPTY_COLUMNS, valueText: v };
    }
    case 'URL': {
      if (isNullish) return null;
      if (typeof raw !== 'string') throw bad(def.key, 'must be a string');
      const v = raw.trim();
      if (!URL_RE.test(v)) throw bad(def.key, 'must be an http(s) URL');
      return { ...EMPTY_COLUMNS, valueText: v };
    }
    case 'PHONE': {
      if (isNullish) return null;
      if (typeof raw !== 'string') throw bad(def.key, 'must be a string');
      const v = raw.trim();
      if (v.length > 40) throw bad(def.key, 'too long');
      return { ...EMPTY_COLUMNS, valueText: v };
    }
    case 'NUMBER':
    case 'MONEY': {
      if (isNullish) return null;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw bad(def.key, 'must be a number');
      return { ...EMPTY_COLUMNS, valueNumber: new Prisma.Decimal(n) };
    }
    case 'DATE': {
      if (isNullish) return null;
      if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
        throw bad(def.key, 'must be a YYYY-MM-DD date');
      }
      return { ...EMPTY_COLUMNS, valueDate: new Date(raw + 'T00:00:00Z') };
    }
    case 'BOOLEAN': {
      // Boolean is special — `false` is a meaningful value and shouldn't be
      // treated as nullish. Only `undefined` / `null` clear it.
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== 'boolean') throw bad(def.key, 'must be a boolean');
      return { ...EMPTY_COLUMNS, valueBool: raw };
    }
    case 'SELECT': {
      if (isNullish) return null;
      if (typeof raw !== 'string') throw bad(def.key, 'must be a string');
      const allowed = selectValueKeys(def);
      if (!allowed.has(raw)) throw bad(def.key, `not in allowed options`);
      return { ...EMPTY_COLUMNS, valueText: raw };
    }
    case 'MULTI_SELECT': {
      if (isNullish) return null;
      if (!Array.isArray(raw)) throw bad(def.key, 'must be an array of strings');
      if (raw.length === 0) return null;
      const allowed = selectValueKeys(def);
      for (const v of raw) {
        if (typeof v !== 'string') throw bad(def.key, 'must be an array of strings');
        if (!allowed.has(v)) throw bad(def.key, `option '${v}' not allowed`);
      }
      // Dedupe to keep storage tidy.
      const unique = Array.from(new Set(raw));
      return { ...EMPTY_COLUMNS, valueJson: unique };
    }
    default:
      throw new HttpError(500, `Unhandled custom-field type: ${String(def.type)}`);
  }
}

function bad(key: string, msg: string): HttpError {
  return new HttpError(400, `customFields.${key}: ${msg}`);
}

/** Flatten a DB row to the JSON value its definition implies. */
export function valueFromRow(
  def: { type: CustomFieldType },
  row: CustomFieldValue,
): AnyValue {
  switch (def.type) {
    case 'TEXT':
    case 'LONG_TEXT':
    case 'EMAIL':
    case 'URL':
    case 'PHONE':
    case 'SELECT':
      return row.valueText;
    case 'NUMBER':
    case 'MONEY':
      return row.valueNumber == null ? null : Number(row.valueNumber);
    case 'DATE':
      return row.valueDate ? row.valueDate.toISOString().slice(0, 10) : null;
    case 'BOOLEAN':
      return row.valueBool;
    case 'MULTI_SELECT':
      return Array.isArray(row.valueJson) ? (row.valueJson as string[]) : null;
    default:
      return null;
  }
}

/**
 * Apply a payload of custom-field values to an entity. Pass an open Prisma
 * transaction so this is atomic with the entity's create/update.
 *
 * Behavior:
 *   - Unknown keys → 400 (typo guardrail).
 *   - Inactive fields → silently ignored (so the FE can re-submit the
 *     read-only value it loaded; no need to filter).
 *   - Required fields → validated *only on create* (when `enforceRequired`
 *     is true). Updates may leave them unset.
 *   - Null / empty value → delete the row.
 */
export async function writeCustomFieldValues(
  tx: Prisma.TransactionClient,
  entityType: CustomFieldEntity,
  entityId: number,
  payload: CustomFieldValuesPayload | undefined,
  opts: { enforceRequired: boolean },
): Promise<void> {
  const defs = await tx.customFieldDefinition.findMany({ where: { entityType } });
  const byKey = new Map(defs.map((d) => [d.key, d] as const));
  const incoming = payload ?? {};

  // Typo guard: unknown keys.
  for (const k of Object.keys(incoming)) {
    if (!byKey.has(k)) throw new HttpError(400, `Unknown custom field: ${k}`);
  }

  // Required check on create.
  if (opts.enforceRequired) {
    for (const def of defs) {
      if (!def.isActive || !def.isRequired) continue;
      const v = incoming[def.key];
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0);
      if (empty && (def.defaultValue == null || def.defaultValue === '')) {
        throw new HttpError(400, `Required custom field '${def.label}' is missing`);
      }
    }
  }

  for (const [key, raw] of Object.entries(incoming)) {
    const def = byKey.get(key)!;
    if (!def.isActive) continue; // ignore writes to inactive fields

    const cols = coerceValue(def, raw);
    if (cols === null) {
      await tx.customFieldValue.deleteMany({
        where: { definitionId: def.id, entityType, entityId },
      });
      continue;
    }
    await tx.customFieldValue.upsert({
      where: {
        definitionId_entityType_entityId: {
          definitionId: def.id,
          entityType,
          entityId,
        },
      },
      create: { definitionId: def.id, entityType, entityId, ...cols },
      update: cols,
    });
  }
}

/**
 * On *create*, also apply default values from active field definitions for
 * any keys not in the payload. Call after the entity row exists.
 */
export async function applyCreateDefaults(
  tx: Prisma.TransactionClient,
  entityType: CustomFieldEntity,
  entityId: number,
  payload: CustomFieldValuesPayload | undefined,
): Promise<void> {
  const defs = await tx.customFieldDefinition.findMany({
    where: { entityType, isActive: true, defaultValue: { not: null } },
  });
  const incoming = payload ?? {};
  for (const def of defs) {
    if (incoming[def.key] !== undefined) continue;
    if (def.defaultValue == null || def.defaultValue === '') continue;
    // Wrap in try/catch so a malformed defaultValue (e.g. a manual SQL edit
    // or schema migration) can't brick all subsequent entity creates. We log
    // and skip the broken default; the entity create still succeeds.
    try {
      let raw: AnyValue;
      try {
        raw =
          def.type === 'MULTI_SELECT' || def.type === 'BOOLEAN' || def.type === 'NUMBER' ||
          def.type === 'MONEY'
            ? (JSON.parse(def.defaultValue) as AnyValue)
            : def.defaultValue;
      } catch {
        raw = def.defaultValue;
      }
      const cols = coerceValue(def, raw);
      if (cols === null) continue;
      await tx.customFieldValue.upsert({
        where: {
          definitionId_entityType_entityId: {
            definitionId: def.id,
            entityType,
            entityId,
          },
        },
        create: { definitionId: def.id, entityType, entityId, ...cols },
        update: cols,
      });
    } catch (err) {
      logger.warn(
        { err, definitionId: def.id, key: def.key, entityType, entityId },
        'Skipping malformed default value for custom field',
      );
    }
  }
}

/**
 * Fetch all custom-field values for one or more entities. Returns a map of
 * entityId → { fieldKey: value }. Inactive definitions are still included in
 * the read so the UI can render them read-only.
 */
export async function loadCustomFieldValues(
  tx: Prisma.TransactionClient | typeof import('../db.js').prisma,
  entityType: CustomFieldEntity,
  entityIds: number[],
): Promise<Map<number, CustomFieldValuesMap>> {
  const out = new Map<number, CustomFieldValuesMap>();
  if (entityIds.length === 0) return out;
  const rows = await tx.customFieldValue.findMany({
    where: { entityType, entityId: { in: entityIds } },
    include: { definition: true },
  });
  for (const id of entityIds) out.set(id, {});
  for (const row of rows) {
    const v = valueFromRow(row.definition, row);
    const m = out.get(row.entityId)!;
    m[row.definition.key] = v as CustomFieldValuesMap[string];
  }
  return out;
}

/** Single-entity convenience wrapper. */
export async function loadCustomFieldValuesFor(
  tx: Prisma.TransactionClient | typeof import('../db.js').prisma,
  entityType: CustomFieldEntity,
  entityId: number,
): Promise<CustomFieldValuesMap> {
  const map = await loadCustomFieldValues(tx, entityType, [entityId]);
  return map.get(entityId) ?? {};
}

export function customFieldDefinitionDto(
  def: CustomFieldDefinition & { _count?: { values: number } },
): CustomFieldDefinitionDto {
  return {
    id: def.id,
    entityType: def.entityType,
    key: def.key,
    label: def.label,
    type: def.type,
    isActive: def.isActive,
    isRequired: def.isRequired,
    defaultValue: def.defaultValue,
    options: (def.options as CustomFieldOptionsConfig) ?? null,
    order: def.order,
    valueCount: def._count?.values ?? 0,
    createdAt: def.createdAt.toISOString(),
    updatedAt: def.updatedAt.toISOString(),
  };
}
