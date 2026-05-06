import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildBuiltinWhere,
  buildCustomFieldValueWhere,
  parseFiltersQueryParam,
  splitFilters,
  CF_KEY_PREFIX,
} from './listFilters.js';
import { HttpError } from './error.js';

describe('parseFiltersQueryParam', () => {
  it('returns [] for empty / nullish input', () => {
    expect(parseFiltersQueryParam(undefined)).toEqual([]);
    expect(parseFiltersQueryParam(null)).toEqual([]);
    expect(parseFiltersQueryParam('')).toEqual([]);
  });

  it('parses a JSON-encoded string', () => {
    const json = JSON.stringify([{ key: 'firstName', op: 'eq', value: 'Sam' }]);
    expect(parseFiltersQueryParam(json)).toEqual([
      { key: 'firstName', op: 'eq', value: 'Sam' },
    ]);
  });

  it('accepts an already-parsed array', () => {
    const arr = [{ key: 'a', op: 'eq', value: 1 }];
    expect(parseFiltersQueryParam(arr)).toEqual(arr);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseFiltersQueryParam('{not-json')).toThrow(/not valid JSON/);
  });

  it('throws when the parsed payload is not an array', () => {
    expect(() => parseFiltersQueryParam('{"key":"x"}')).toThrow(/must be an array/);
  });

  it('rejects entries that fail listFilterSchema', () => {
    expect(() => parseFiltersQueryParam('[{"key":"x","op":"bogus"}]')).toThrow();
  });
});

describe('splitFilters', () => {
  it('routes cf:* keys to the cf bucket and others to builtin', () => {
    const split = splitFilters([
      { key: 'firstName', op: 'eq', value: 'Sam' },
      { key: `${CF_KEY_PREFIX}persona`, op: 'eq', value: 'buyer' },
      { key: 'companyId', op: 'eq', value: 5 },
    ]);
    expect(split.builtin.map((f) => f.key)).toEqual(['firstName', 'companyId']);
    expect(split.cf.map((f) => f.key)).toEqual([`${CF_KEY_PREFIX}persona`]);
  });
});

describe('buildBuiltinWhere', () => {
  it('flattens single-occurrence keys', () => {
    const where = buildBuiltinWhere('CONTACT', [
      { key: 'firstName', op: 'contains', value: 'sa' },
      { key: 'companyId', op: 'eq', value: 7 },
    ]);
    expect(where).toEqual({
      firstName: { contains: 'sa', mode: 'insensitive' },
      companyId: 7,
    });
  });

  it('combines multiple filters on the same key via top-level AND', () => {
    const where = buildBuiltinWhere('DEAL', [
      { key: 'amount', op: 'gte', value: 100 },
      { key: 'amount', op: 'lt', value: 500 },
    ]);
    expect(where).toEqual({
      AND: [
        { amount: { gte: 100 } },
        { amount: { lt: 500 } },
      ],
    });
  });

  it('rejects unknown filter fields', () => {
    expect(() =>
      buildBuiltinWhere('CONTACT', [{ key: 'ssn', op: 'eq', value: '1' }]),
    ).toThrow(/Unknown filter field/);
  });

  it('rejects ops the field type does not support', () => {
    // companyId is an idField — `contains` is not allowed.
    expect(() =>
      buildBuiltinWhere('CONTACT', [{ key: 'companyId', op: 'contains', value: 'x' }]),
    ).toThrow(/not supported on id field/);
  });

  it('NaN-guards id-field values', () => {
    expect(() =>
      buildBuiltinWhere('CONTACT', [{ key: 'companyId', op: 'eq', value: 'abc' }]),
    ).toThrow(/positive integer/);
  });

  it('renders is_set / is_not_set for string fields', () => {
    expect(
      buildBuiltinWhere('CONTACT', [{ key: 'email', op: 'is_set' }]),
    ).toEqual({ email: { not: null } });
    expect(
      buildBuiltinWhere('CONTACT', [{ key: 'email', op: 'is_not_set' }]),
    ).toEqual({ email: null });
  });

  describe('archivedAt (dateTime field)', () => {
    it('is_set surfaces only archived deals', () => {
      expect(
        buildBuiltinWhere('DEAL', [{ key: 'archivedAt', op: 'is_set' }]),
      ).toEqual({ archivedAt: { not: null } });
    });

    it('rejects is_not_set (intentionally unsupported, mirrors cf DATE)', () => {
      expect(() =>
        buildBuiltinWhere('DEAL', [{ key: 'archivedAt', op: 'is_not_set' }]),
      ).toThrow(/not supported on date field/);
    });

    it('parses YYYY-MM-DD as start-of-day UTC for comparison ops', () => {
      const w = buildBuiltinWhere<{ archivedAt: { gte: Date } }>('DEAL', [
        { key: 'archivedAt', op: 'gte', value: '2026-05-01' },
      ]);
      expect(w.archivedAt.gte).toBeInstanceOf(Date);
      expect(w.archivedAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    });

    it('rejects malformed date values', () => {
      expect(() =>
        buildBuiltinWhere('DEAL', [{ key: 'archivedAt', op: 'gte', value: 'not-a-date' }]),
      ).toThrow(/invalid date/);
    });

    it('requires a value for comparison ops', () => {
      expect(() =>
        buildBuiltinWhere('DEAL', [{ key: 'archivedAt', op: 'gt', value: '' }]),
      ).toThrow(/requires a value/);
    });
  });
});

describe('buildCustomFieldValueWhere', () => {
  const def = 11; // arbitrary definition id
  const ent = 'CONTACT' as const;

  it('text eq / contains / starts_with / neq', () => {
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'eq', 'hi'))
      .toEqual({ definitionId: def, entityType: ent, valueText: 'hi' });
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'contains', 'i'))
      .toEqual({ definitionId: def, entityType: ent, valueText: { contains: 'i', mode: 'insensitive' } });
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'starts_with', 'h'))
      .toEqual({ definitionId: def, entityType: ent, valueText: { startsWith: 'h', mode: 'insensitive' } });
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'neq', 'x'))
      .toEqual({ definitionId: def, entityType: ent, valueText: { not: 'x' } });
  });

  it('text in/not_in with empty arrays returns NONE/ALL', () => {
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'in', [])).toBe('NONE');
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'not_in', [])).toBe('ALL');
  });

  it('number ops produce Decimal predicates', () => {
    const w = buildCustomFieldValueWhere('NUMBER', def, ent, 'gte', 10);
    expect(w).toMatchObject({ definitionId: def, entityType: ent });
    const valueNumber = (w as { valueNumber: { gte: Prisma.Decimal } }).valueNumber;
    expect(valueNumber.gte).toBeInstanceOf(Prisma.Decimal);
    expect(valueNumber.gte.toNumber()).toBe(10);
  });

  it('number ops reject NaN', () => {
    expect(() => buildCustomFieldValueWhere('NUMBER', def, ent, 'eq', 'nope')).toThrow(/invalid number/);
  });

  it('date ops require YYYY-MM-DD', () => {
    expect(() => buildCustomFieldValueWhere('DATE', def, ent, 'eq', '2026/04/30'))
      .toThrow(/invalid date/);
    const ok = buildCustomFieldValueWhere('DATE', def, ent, 'gte', '2026-04-30');
    expect(ok).toMatchObject({ definitionId: def, entityType: ent });
  });

  it('boolean ops', () => {
    expect(buildCustomFieldValueWhere('BOOLEAN', def, ent, 'is_true'))
      .toEqual({ definitionId: def, entityType: ent, valueBool: true });
    expect(buildCustomFieldValueWhere('BOOLEAN', def, ent, 'is_false'))
      .toEqual({ definitionId: def, entityType: ent, valueBool: false });
    expect(buildCustomFieldValueWhere('BOOLEAN', def, ent, 'eq', true))
      .toEqual({ definitionId: def, entityType: ent, valueBool: true });
  });

  it('multi-select contains = AND of array_contains; in = OR', () => {
    const cAnd = buildCustomFieldValueWhere('MULTI_SELECT', def, ent, 'contains', ['a', 'b']);
    expect(cAnd).toMatchObject({
      definitionId: def, entityType: ent,
      AND: [{ valueJson: { array_contains: ['a'] } }, { valueJson: { array_contains: ['b'] } }],
    });
    const cOr = buildCustomFieldValueWhere('MULTI_SELECT', def, ent, 'in', ['a', 'b']);
    expect(cOr).toMatchObject({
      definitionId: def, entityType: ent,
      OR: [{ valueJson: { array_contains: ['a'] } }, { valueJson: { array_contains: ['b'] } }],
    });
  });

  it('is_set returns the not-null clause for the right column', () => {
    expect(buildCustomFieldValueWhere('TEXT', def, ent, 'is_set'))
      .toEqual({ definitionId: def, entityType: ent, valueText: { not: null } });
    expect(buildCustomFieldValueWhere('NUMBER', def, ent, 'is_set'))
      .toEqual({ definitionId: def, entityType: ent, valueNumber: { not: null } });
    expect(buildCustomFieldValueWhere('DATE', def, ent, 'is_set'))
      .toEqual({ definitionId: def, entityType: ent, valueDate: { not: null } });
    expect(buildCustomFieldValueWhere('BOOLEAN', def, ent, 'is_set'))
      .toEqual({ definitionId: def, entityType: ent, valueBool: { not: null } });
  });

  it('is_not_set is intentionally unsupported for cf fields', () => {
    expect(() => buildCustomFieldValueWhere('TEXT', def, ent, 'is_not_set'))
      .toThrow(HttpError);
  });

  it('rejects ops that the type does not handle', () => {
    expect(() => buildCustomFieldValueWhere('BOOLEAN', def, ent, 'gt'))
      .toThrow(/not supported for type BOOLEAN/);
    // For DATE we have to supply a valid value so the op-fallthrough is the
    // path that fails (the value check runs first).
    expect(() => buildCustomFieldValueWhere('DATE', def, ent, 'contains', '2026-01-01'))
      .toThrow(/not supported for type DATE/);
  });
});
