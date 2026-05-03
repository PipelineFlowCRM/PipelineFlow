import { z } from 'zod';
import type { ValidatedRow, ValidationError } from './types.js';
import { parsePhone } from '../parsers/phone.js';
import { parseUrl } from '../parsers/url.js';

// Mirror of Company canonical fields. Required: name. Everything else is
// nullable — an existing record's column won't be overwritten with null
// (see job-runner.ts).
export interface CompanyImportRecord {
  name: string;
  industry: string | null;
  website: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
  externalId: string | null;
  externalSource: string | null;
}

const STR = (max: number) => z.string().trim().max(max).optional().nullable();
const REQ = (max: number) => z.string().trim().min(1).max(max);

const schema = z.object({
  name: REQ(200),
  industry: STR(120),
  website: STR(255),
  phone: STR(40),
  addressLine1: STR(200),
  addressLine2: STR(200),
  city: STR(100),
  state: STR(60),
  postalCode: STR(20),
  notes: STR(10_000),
  externalId: STR(120),
  externalSource: STR(60),
});

// `cell` accessors: take the raw row, pull the column the user mapped to
// `field`, and return the trimmed string or null. Centralizing this keeps
// validators agnostic of which source-CSV column carries which canonical
// field — that's the wizard's responsibility.
export function makeCellReader(
  row: Record<string, string | undefined>,
  mapping: Record<string, string | null>,
) {
  // Reverse-index: canonical field → CSV header. We pick the first match
  // when the user has accidentally mapped two headers to the same field
  // (the wizard prevents this, but a hand-crafted POST might still try).
  const reverse = new Map<string, string>();
  for (const [csvHeader, canonical] of Object.entries(mapping)) {
    if (canonical && !reverse.has(canonical)) reverse.set(canonical, csvHeader);
  }
  return (field: string): { header: string | null; value: string | null } => {
    const header = reverse.get(field) ?? null;
    if (!header) return { header: null, value: null };
    const raw = row[header];
    if (raw == null) return { header, value: null };
    const trimmed = String(raw).trim();
    return { header, value: trimmed === '' ? null : trimmed };
  };
}

export function validateCompanyRow(
  row: Record<string, string | undefined>,
  mapping: Record<string, string | null>,
  rowNumber: number,
): ValidatedRow<CompanyImportRecord> {
  const cell = makeCellReader(row, mapping);
  const errors: ValidationError[] = [];

  const websiteCell = cell('website');
  let website: string | null = websiteCell.value;
  if (website) {
    const u = parseUrl(website);
    if (u.error) {
      errors.push({ row: rowNumber, column: websiteCell.header, value: websiteCell.value, reason: u.error });
      website = null;
    } else {
      website = u.value;
    }
  }
  const phoneCell = cell('phone');
  const phone = parsePhone(phoneCell.value);

  const candidate = {
    name: cell('name').value,
    industry: cell('industry').value,
    website,
    phone,
    addressLine1: cell('addressLine1').value,
    addressLine2: cell('addressLine2').value,
    city: cell('city').value,
    state: cell('state').value,
    postalCode: cell('postalCode').value,
    notes: cell('notes').value,
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

  // Fill nullables with null so downstream Prisma writes are consistent.
  const filled: CompanyImportRecord = {
    name: result.data.name,
    industry: result.data.industry ?? null,
    website: result.data.website ?? null,
    phone: result.data.phone ?? null,
    addressLine1: result.data.addressLine1 ?? null,
    addressLine2: result.data.addressLine2 ?? null,
    city: result.data.city ?? null,
    state: result.data.state ?? null,
    postalCode: result.data.postalCode ?? null,
    notes: result.data.notes ?? null,
    externalId: result.data.externalId ?? null,
    externalSource: result.data.externalSource ?? null,
  };
  return { data: filled, errors };
}
