import { z } from 'zod';
import type { ValidatedRow, ValidationError } from './types.js';
import { makeCellReader } from './company.js';
import { parseAmount } from '../parsers/amount.js';
import { parseDate } from '../parsers/date.js';

export interface DealImportRecord {
  title: string;
  amount: number | null;
  currency: string | null;
  probability: number | null;
  expectedCloseDate: string | null; // YYYY-MM-DD
  // Source values for resolution — matched against PipelineStage.name via
  // the user-provided stageMapping at runtime.
  stageName: string | null;
  companyName: string | null;
  companyExternalId: string | null;
  primaryContactEmail: string | null;
  externalId: string | null;
  externalSource: string | null;
}

const STR = (max: number) => z.string().trim().max(max).optional().nullable();
const REQ = (max: number) => z.string().trim().min(1).max(max);

const schema = z.object({
  title: REQ(200),
  amount: z.number().nullable().optional(),
  currency: STR(8),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: STR(20),
  stageName: STR(100),
  companyName: STR(200),
  companyExternalId: STR(120),
  primaryContactEmail: STR(255),
  externalId: STR(120),
  externalSource: STR(60),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateDealRow(
  row: Record<string, string | undefined>,
  mapping: Record<string, string | null>,
  rowNumber: number,
): ValidatedRow<DealImportRecord> {
  const cell = makeCellReader(row, mapping);
  const errors: ValidationError[] = [];

  const amountCell = cell('amount');
  const amountResult = parseAmount(amountCell.value);
  if (amountResult.error) {
    errors.push({
      row: rowNumber,
      column: amountCell.header,
      value: amountCell.value,
      reason: amountResult.error,
    });
  }

  const dateCell = cell('expectedCloseDate');
  const dateResult = parseDate(dateCell.value);
  if (dateResult.error) {
    errors.push({
      row: rowNumber,
      column: dateCell.header,
      value: dateCell.value,
      reason: dateResult.error,
    });
  }

  const probCell = cell('probability');
  let probability: number | null = null;
  if (probCell.value != null) {
    const stripped = probCell.value.replace(/[^\d.-]/g, '');
    const n = stripped === '' ? NaN : Number(stripped);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.push({
        row: rowNumber,
        column: probCell.header,
        value: probCell.value,
        reason: `probability: must be 0–100`,
      });
    } else {
      probability = Math.round(n);
    }
  }

  const emailCell = cell('primaryContactEmail');
  let primaryContactEmail: string | null = emailCell.value;
  if (primaryContactEmail && !EMAIL_RE.test(primaryContactEmail.toLowerCase())) {
    errors.push({
      row: rowNumber,
      column: emailCell.header,
      value: emailCell.value,
      reason: `primaryContactEmail: invalid email format`,
    });
    primaryContactEmail = null;
  } else if (primaryContactEmail) {
    primaryContactEmail = primaryContactEmail.toLowerCase();
  }

  const candidate = {
    title: cell('title').value,
    amount: amountResult.value,
    currency: cell('currency').value,
    probability,
    expectedCloseDate: dateResult.value,
    stageName: cell('stageName').value,
    companyName: cell('companyName').value,
    companyExternalId: cell('companyExternalId').value,
    primaryContactEmail,
    externalId: cell('externalId').value,
    externalSource: cell('externalSource').value,
  };

  const result = schema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0] as string | undefined;
      const header = field ? cell(field).header : null;
      const value = field ? cell(field).value : null;
      errors.push({
        row: rowNumber,
        column: header,
        value,
        reason: `${field ?? 'row'}: ${issue.message}`,
      });
    }
    return { data: null, errors };
  }

  // P0-7: stageName is required for Deal imports because every Deal needs
  // a stageId. The stage mapping sub-step ensures every distinct source
  // stage is bound to a PipelineStage; an unmapped stage name surfaces as
  // a validation error at commit time (handled in the job runner).
  if (!result.data.stageName) {
    errors.push({
      row: rowNumber,
      column: null,
      value: null,
      reason: 'stageName: required (map a CSV column to "stageName" or fix this row)',
    });
    return { data: null, errors };
  }

  const filled: DealImportRecord = {
    title: result.data.title,
    amount: result.data.amount ?? null,
    currency: result.data.currency ?? null,
    probability: result.data.probability ?? null,
    expectedCloseDate: result.data.expectedCloseDate ?? null,
    stageName: result.data.stageName ?? null,
    companyName: result.data.companyName ?? null,
    companyExternalId: result.data.companyExternalId ?? null,
    primaryContactEmail: result.data.primaryContactEmail ?? null,
    externalId: result.data.externalId ?? null,
    externalSource: result.data.externalSource ?? null,
  };
  return { data: filled, errors };
}
