import { z } from 'zod';
import type { ValidatedRow, ValidationError } from './types.js';
import { makeCellReader } from './company.js';
import { parseDatetime } from '../parsers/date.js';

// Note imports always attach to a Deal in PipelineFlow. The validator
// captures the source identifiers needed for cross-entity resolution at
// commit time:
//   - `dealExternalId` (preferred): exact match against a previously-
//     imported Deal's `(externalSource, externalId)`. Pipedrive Notes
//     exports include `Deal ID` for this purpose.
//   - `dealTitle` (fallback): used only when externalId resolution
//     fails AND the title is unique among existing Deals. Ambiguous
//     titles become row-level errors.
// Notes whose source row carries no Deal reference at all (org-only or
// person-only Pipedrive notes) are dropped at commit time with a clear
// "no Deal ID" error since PipelineFlow's Note model requires a parent
// Deal.
export interface NoteImportRecord {
  content: string;
  dealExternalId: string | null;
  dealTitle: string | null;
  // Pipedrive's "Add time" — used to override the Note row's `createdAt`
  // so timeline ordering survives the migration. Stored as a full ISO
  // datetime (with time precision) rather than a date-only string so
  // multiple notes from the same day keep distinct timestamps and
  // preserve their relative ordering on the deal timeline.
  addTime: string | null; // ISO-8601 datetime, UTC anchored
  // Pipedrive emits the user's display name only (no email). We can't
  // reliably resolve to a PipelineFlow User row, so this is preserved
  // as a content prefix at commit time and `createdBy` stays null.
  authorName: string | null;
  externalId: string | null;
  externalSource: string | null;
}

const STR = (max: number) => z.string().trim().max(max).optional().nullable();

const schema = z.object({
  // 32 KB cap matches Note.content Postgres TEXT in practice; users with
  // genuinely longer notes will get a row-level error rather than a
  // silent truncation.
  content: z.string().trim().min(1).max(32_000),
  dealExternalId: STR(120),
  dealTitle: STR(200),
  // ISO-8601 datetime is 24 chars; bumping to 40 leaves room for any
  // pre-parsing chrono variants we let through.
  addTime: STR(40),
  authorName: STR(120),
  externalId: STR(120),
  externalSource: STR(60),
});

export function validateNoteRow(
  row: Record<string, string | undefined>,
  mapping: Record<string, string | null>,
  rowNumber: number,
): ValidatedRow<NoteImportRecord> {
  const cell = makeCellReader(row, mapping);
  const errors: ValidationError[] = [];

  // `addTime` flows through the datetime parser so Pipedrive's
  // `2013-12-16 20:32:02` round-trips with full precision. Multiple
  // notes from the same day need distinct timestamps to preserve their
  // ordering on the deal timeline. An invalid string surfaces a
  // row-level error and falls back to "no override" (upsert lets
  // `createdAt` default to now()).
  const addTimeCell = cell('addTime');
  let addTime: string | null = null;
  if (addTimeCell.value) {
    const parsed = parseDatetime(addTimeCell.value);
    if (parsed.error) {
      errors.push({
        row: rowNumber,
        column: addTimeCell.header,
        value: addTimeCell.value,
        reason: parsed.error,
      });
    } else {
      addTime = parsed.value;
    }
  }

  const candidate = {
    content: cell('content').value,
    dealExternalId: cell('dealExternalId').value,
    dealTitle: cell('dealTitle').value,
    addTime,
    authorName: cell('authorName').value,
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

  // Either dealExternalId or dealTitle must be present — without one of
  // them we have nothing to resolve a parent Deal from. (Per the user's
  // ask we explicitly drop org-only / contact-only notes.)
  if (!result.data.dealExternalId && !result.data.dealTitle) {
    errors.push({
      row: rowNumber,
      column: null,
      value: null,
      reason:
        'note has no Deal reference (Pipedrive: Deal ID or Deal title is required) — org/contact-only notes are not imported',
    });
    return { data: null, errors };
  }

  const filled: NoteImportRecord = {
    content: result.data.content,
    dealExternalId: result.data.dealExternalId ?? null,
    dealTitle: result.data.dealTitle ?? null,
    addTime: result.data.addTime ?? null,
    authorName: result.data.authorName ?? null,
    externalId: result.data.externalId ?? null,
    externalSource: result.data.externalSource ?? null,
  };
  return { data: filled, errors };
}
