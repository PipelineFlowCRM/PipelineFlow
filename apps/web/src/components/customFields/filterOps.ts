// Per-type operator menus and value-renderer hints. Mirrors the server-side
// allowed ops in apps/api/src/lib/listFilters.ts.

import type { CustomFieldType, ListFilterOp } from '@pipelineflow/shared';

export const CF_KEY_PREFIX = 'cf:';

export const opLabels: Record<ListFilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  starts_with: 'starts with',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_true: 'is true',
  is_false: 'is false',
  in: 'is one of',
  not_in: 'is not one of',
  is_set: 'has value',
  is_not_set: 'has no value',
};

export function opsForType(type: CustomFieldType): ListFilterOp[] {
  switch (type) {
    case 'TEXT':
    case 'LONG_TEXT':
    case 'EMAIL':
    case 'URL':
    case 'PHONE':
      return ['contains', 'starts_with', 'eq', 'neq', 'is_set'];
    case 'NUMBER':
    case 'MONEY':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_set'];
    case 'DATE':
      return ['eq', 'gt', 'gte', 'lt', 'lte', 'is_set'];
    case 'BOOLEAN':
      return ['is_true', 'is_false'];
    case 'SELECT':
      return ['eq', 'neq', 'in', 'not_in', 'is_set'];
    case 'MULTI_SELECT':
      return ['contains', 'in', 'is_set'];
    default:
      return ['eq'];
  }
}

export type ValueRenderer = 'text' | 'number' | 'date' | 'select' | 'none';

export function valueRendererForType(type: CustomFieldType): ValueRenderer {
  switch (type) {
    case 'NUMBER':
    case 'MONEY':
      return 'number';
    case 'DATE':
      return 'date';
    case 'BOOLEAN':
      return 'none';
    case 'SELECT':
    case 'MULTI_SELECT':
      return 'select';
    default:
      return 'text';
  }
}
