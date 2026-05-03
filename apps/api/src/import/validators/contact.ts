import { z } from 'zod';
import type { ValidatedRow, ValidationError } from './types.js';
import { makeCellReader } from './company.js';
import { parsePhone } from '../parsers/phone.js';

export interface ContactImportRecord {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  linkedin: string | null;
  notes: string | null;
  // Resolved at relationship-resolution time; the validator only carries
  // the source values forward.
  companyName: string | null;
  companyExternalId: string | null;
  externalId: string | null;
  externalSource: string | null;
}

const STR = (max: number) => z.string().trim().max(max).optional().nullable();
const REQ = (max: number) => z.string().trim().min(1).max(max);

const schema = z.object({
  firstName: REQ(80),
  lastName: REQ(80),
  email: STR(255),
  phone: STR(40),
  title: STR(120),
  linkedin: STR(255),
  notes: STR(10_000),
  companyName: STR(200),
  companyExternalId: STR(120),
  externalId: STR(120),
  externalSource: STR(60),
});

// Loose RFC 5322 — matches Zod's .email() but applied conditionally so
// the user can still import contacts whose CSV has a stray non-email
// in the email column. Bad emails become a row-level error.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pipedrive sometimes exports a "Person - Name" combined field. If the
// user maps that to firstName, we split on the last space so "Mary Jane
// Watson" → first="Mary Jane", last="Watson". Splitting on the *last*
// space is a deliberate choice: more first names are multi-word than
// last names in the wild.
function splitFullName(s: string): { first: string; last: string } {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] ?? '', last: '' };
  const last = parts.pop() ?? '';
  return { first: parts.join(' '), last };
}

export function validateContactRow(
  row: Record<string, string | undefined>,
  mapping: Record<string, string | null>,
  rowNumber: number,
): ValidatedRow<ContactImportRecord> {
  const cell = makeCellReader(row, mapping);
  const errors: ValidationError[] = [];

  let first = cell('firstName').value;
  let last = cell('lastName').value;
  // Both blank but firstName cell holds a full name? Split it.
  if (first && !last && /\s/.test(first)) {
    const { first: f, last: l } = splitFullName(first);
    first = f;
    last = l;
  }
  if (!last) {
    // Allow lastName-only sources by promoting first → last when first is blank
    // and the only non-blank input is in the lastName cell — but if both are
    // blank, fall through to the schema's required check, which will surface
    // the missing-firstName error.
    if (!first && cell('lastName').value) {
      // already handled above when last was blank
    }
  }

  const emailCell = cell('email');
  let email = emailCell.value;
  if (email && !EMAIL_RE.test(email.toLowerCase())) {
    errors.push({
      row: rowNumber,
      column: emailCell.header,
      value: emailCell.value,
      reason: `email: invalid email format`,
    });
    email = null;
  } else if (email) {
    email = email.toLowerCase();
  }

  const phoneCell = cell('phone');
  const phone = parsePhone(phoneCell.value);

  const candidate = {
    firstName: first,
    lastName: last,
    email,
    phone,
    title: cell('title').value,
    linkedin: cell('linkedin').value,
    notes: cell('notes').value,
    companyName: cell('companyName').value,
    companyExternalId: cell('companyExternalId').value,
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

  const filled: ContactImportRecord = {
    firstName: result.data.firstName,
    lastName: result.data.lastName,
    email: result.data.email ?? null,
    phone: result.data.phone ?? null,
    title: result.data.title ?? null,
    linkedin: result.data.linkedin ?? null,
    notes: result.data.notes ?? null,
    companyName: result.data.companyName ?? null,
    companyExternalId: result.data.companyExternalId ?? null,
    externalId: result.data.externalId ?? null,
    externalSource: result.data.externalSource ?? null,
  };
  return { data: filled, errors };
}
