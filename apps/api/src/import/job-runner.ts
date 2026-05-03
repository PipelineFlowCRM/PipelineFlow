import type { Prisma, PrismaClient } from '@prisma/client';
import { csvEscape } from '../lib/csv.js';
import { parseCsv } from './parser.js';
import { validateCompanyRow, type CompanyImportRecord } from './validators/company.js';
import { validateContactRow, type ContactImportRecord } from './validators/contact.js';
import { validateDealRow, type DealImportRecord } from './validators/deal.js';
import type { ValidationError } from './validators/types.js';
import { CompanyResolver } from './resolvers/company.js';
import { ContactResolver } from './resolvers/contact.js';
import { StageResolver } from './resolvers/stage.js';
import { getImportSource } from './storage.js';

export type EntityType = 'company' | 'contact' | 'deal';

export interface RunSummary {
  totalRows: number;
  willCreate: number;
  willUpdate: number;
  willError: number;
  // Stub-creation counters for cross-entity resolution; meaningful only on
  // commit (dry-runs don't actually create anything). 0 on dry-runs.
  stubCompaniesCreated: number;
  stubContactsCreated: number;
  // Surfaces from P0-7 — distinct source stages that have no PipelineStage
  // mapping yet. The wizard renders these in the stage-mapping sub-step.
  unmappedStages: string[];
  // Distinct stage values seen in the file — populated for Deal imports
  // even on a fresh dry-run so the UI can build the sub-step's row list
  // without re-parsing.
  distinctStages: string[];
}

export interface RunResult {
  summary: RunSummary;
  errors: ValidationError[];
  // Set on commit only. Lists the IDs of created/updated rows so the UI
  // can deep-link to the imported records.
  createdIds?: number[];
  updatedIds?: number[];
}

export interface RunOptions {
  entityType: EntityType;
  mapping: Record<string, string | null>;
  // Required for Deal imports; ignored otherwise.
  stageMapping?: Record<string, number>;
  // Optional bucket key used to stamp externalSource when the column
  // isn't explicitly mapped from the CSV. The preset detection layer
  // sets this on upload — defaults to "csv" when absent.
  externalSource?: string;
  // Dry-run does everything except the writes. Errors and counts are
  // identical to a real commit; only the `createdIds`/`updatedIds`
  // fields differ.
  commit: boolean;
}

const ERROR_CAP = 1000;

// Maximum row count we'll accept synchronously per spec §10. Above this
// the job runner returns a single row-0 error directing the user to split
// the file. Background processing is P1.
export const MAX_ROWS = 50_000;

export interface RawCsvData {
  headers: string[];
  rows: Record<string, string>[];
  parseErrors: ValidationError[];
}

// Parse + cap. Pulled out so dry-run and commit share the same input
// handling — a row count over the cap shouldn't even attempt validation.
export async function loadCsvFromStorage(sourceFile: string): Promise<RawCsvData> {
  const buffer = await getImportSource(sourceFile);
  const text = buffer.toString('utf-8');
  const parsed = parseCsv(text);
  const parseErrors: ValidationError[] = parsed.errors.map((e) => ({
    row: e.row,
    column: e.column,
    value: null,
    reason: e.reason,
  }));
  return {
    headers: parsed.headers,
    rows: parsed.rows,
    parseErrors,
  };
}

export async function runImport(
  prisma: PrismaClient,
  sourceFile: string,
  opts: RunOptions,
): Promise<RunResult> {
  const { headers, rows, parseErrors } = await loadCsvFromStorage(sourceFile);
  const errors: ValidationError[] = [...parseErrors];

  if (rows.length > MAX_ROWS) {
    errors.push({
      row: 0,
      column: null,
      value: null,
      reason: `Too many rows (${rows.length}). Maximum is ${MAX_ROWS} — split the file and import each part.`,
    });
    return {
      summary: zeroSummary(rows.length),
      errors,
    };
  }

  // Pre-validate every row. We always do this before touching the DB so a
  // bad mapping or schema mismatch produces a coherent error report
  // instead of a half-imported state.
  type ValidatedAny =
    | { kind: 'company'; record: CompanyImportRecord; rowNumber: number }
    | { kind: 'contact'; record: ContactImportRecord; rowNumber: number }
    | { kind: 'deal'; record: DealImportRecord; rowNumber: number };
  const validated: ValidatedAny[] = [];
  rows.forEach((row, index) => {
    // Row 1 is the header line; row 2 is the first data row.
    const rowNumber = index + 2;
    if (opts.entityType === 'company') {
      const v = validateCompanyRow(row, opts.mapping, rowNumber);
      if (v.errors.length > 0) errors.push(...v.errors);
      if (v.data) validated.push({ kind: 'company', record: v.data, rowNumber });
    } else if (opts.entityType === 'contact') {
      const v = validateContactRow(row, opts.mapping, rowNumber);
      if (v.errors.length > 0) errors.push(...v.errors);
      if (v.data) validated.push({ kind: 'contact', record: v.data, rowNumber });
    } else {
      const v = validateDealRow(row, opts.mapping, rowNumber);
      if (v.errors.length > 0) errors.push(...v.errors);
      if (v.data) validated.push({ kind: 'deal', record: v.data, rowNumber });
    }
  });

  // For Deal imports, resolve stage mappings up-front so unmapped stages
  // turn into row-level errors before we touch the DB.
  let stageResolver: StageResolver | null = null;
  let distinctStages: string[] = [];
  let unmappedStages: string[] = [];
  if (opts.entityType === 'deal') {
    distinctStages = Array.from(
      new Set(
        validated
          .filter((v): v is Extract<ValidatedAny, { kind: 'deal' }> => v.kind === 'deal')
          .map((v) => v.record.stageName)
          .filter((s): s is string => !!s),
      ),
    );
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: distinctStages,
      stageMapping: opts.stageMapping ?? {},
    });
    stageResolver = built.resolver;
    unmappedStages = built.unmapped;
    if (unmappedStages.length > 0) {
      // Pin a top-of-list error so dry-run output makes the cause obvious.
      errors.push({
        row: 0,
        column: null,
        value: null,
        reason: `Map every distinct stage before committing. Unmapped: ${unmappedStages.join(', ')}`,
      });
    }
  }

  const externalSource = opts.externalSource ?? 'csv';

  // Dry-run path: predict create/update counts by looking up each row's
  // existing match. We *don't* run the resolvers here — those would
  // create stub Companies/Contacts on a dry-run.
  if (!opts.commit) {
    let willCreate = 0;
    let willUpdate = 0;
    for (const v of validated) {
      if (v.kind === 'deal' && stageResolver && unmappedStages.length > 0) {
        // Skip the per-row create/update prediction when the stage map
        // is incomplete — every row would be an error anyway.
        continue;
      }
      const matchExists = await predictMatch(prisma, v, externalSource);
      if (matchExists) willUpdate += 1;
      else willCreate += 1;
    }
    const willError = countDistinctRowsWithErrors(errors);
    return {
      summary: {
        totalRows: rows.length,
        willCreate,
        willUpdate,
        willError,
        stubCompaniesCreated: 0,
        stubContactsCreated: 0,
        unmappedStages,
        distinctStages,
      },
      errors: errors.slice(0, ERROR_CAP),
    };
  }

  // Commit path. We run each row in its own micro-transaction rather than
  // wrapping the whole thing — a 1 000-row file would otherwise lock for
  // seconds, and a single bad row would roll back 999 good ones (the spec
  // explicitly says one bad row should not block clean rows).
  const createdIds: number[] = [];
  const updatedIds: number[] = [];
  let stubCompaniesCreated = 0;
  let stubContactsCreated = 0;

  // Single CompanyResolver / ContactResolver shared across rows — that's
  // how we get the "30 references to Acme Corp create 1 Company" cache.
  const companyResolver = new CompanyResolver(prisma, externalSource);
  const contactResolver = new ContactResolver(prisma);

  for (const v of validated) {
    try {
      if (v.kind === 'company') {
        const r = await upsertCompany(prisma, v.record, externalSource);
        if (r.created) createdIds.push(r.id);
        else updatedIds.push(r.id);
      } else if (v.kind === 'contact') {
        const companyId = await companyResolver.resolve({
          name: v.record.companyName,
          externalId: v.record.companyExternalId,
        });
        const r = await upsertContact(prisma, v.record, companyId, externalSource);
        if (r.created) createdIds.push(r.id);
        else updatedIds.push(r.id);
      } else {
        if (unmappedStages.length > 0 || !stageResolver) {
          // Already reported above; skip this row.
          continue;
        }
        const stageId = stageResolver.idFor(v.record.stageName);
        if (stageId == null) {
          errors.push({
            row: v.rowNumber,
            column: null,
            value: v.record.stageName,
            reason: `stageName: no PipelineStage mapping for "${v.record.stageName}"`,
          });
          continue;
        }
        const companyId = await companyResolver.resolve({
          name: v.record.companyName,
          externalId: v.record.companyExternalId,
        });
        const primaryContactId = await contactResolver.resolveByEmail(
          v.record.primaryContactEmail,
        );
        const r = await upsertDeal(
          prisma,
          v.record,
          { companyId, primaryContactId, stageId },
          externalSource,
        );
        if (r.created) createdIds.push(r.id);
        else updatedIds.push(r.id);
      }
    } catch (err) {
      // We surface the error against the row but keep going — the spec is
      // explicit that one bad row must not stop the rest.
      errors.push({
        row: v.rowNumber,
        column: null,
        value: null,
        reason: `commit failed: ${(err as Error).message}`,
      });
    }
  }

  stubCompaniesCreated = companyResolver.stubsCreated;
  stubContactsCreated = contactResolver.stubsCreated;

  return {
    summary: {
      totalRows: rows.length,
      willCreate: createdIds.length,
      willUpdate: updatedIds.length,
      willError: countDistinctRowsWithErrors(errors),
      stubCompaniesCreated,
      stubContactsCreated,
      unmappedStages,
      distinctStages,
    },
    errors: errors.slice(0, ERROR_CAP),
    createdIds,
    updatedIds,
  };
}

function zeroSummary(totalRows: number): RunSummary {
  return {
    totalRows,
    willCreate: 0,
    willUpdate: 0,
    willError: totalRows,
    stubCompaniesCreated: 0,
    stubContactsCreated: 0,
    unmappedStages: [],
    distinctStages: [],
  };
}

function countDistinctRowsWithErrors(errors: ValidationError[]): number {
  const rows = new Set<number>();
  for (const e of errors) if (e.row > 0) rows.add(e.row);
  return rows.size;
}

async function predictMatch(
  prisma: PrismaClient,
  v:
    | { kind: 'company'; record: CompanyImportRecord }
    | { kind: 'contact'; record: ContactImportRecord }
    | { kind: 'deal'; record: DealImportRecord },
  externalSource: string,
): Promise<boolean> {
  if (v.kind === 'company') {
    if (v.record.externalId) {
      const e = await prisma.company.findUnique({
        where: {
          company_external_uq: {
            externalSource: v.record.externalSource ?? externalSource,
            externalId: v.record.externalId,
          },
        },
        select: { id: true },
      });
      if (e) return true;
    }
    if (v.record.name) {
      const n = await prisma.company.findFirst({
        where: { name: { equals: v.record.name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (n) return true;
    }
    return false;
  }
  if (v.kind === 'contact') {
    if (v.record.externalId) {
      const e = await prisma.contact.findUnique({
        where: {
          contact_external_uq: {
            externalSource: v.record.externalSource ?? externalSource,
            externalId: v.record.externalId,
          },
        },
        select: { id: true },
      });
      if (e) return true;
    }
    if (v.record.email) {
      const m = await prisma.contact.findFirst({
        where: { email: { equals: v.record.email, mode: 'insensitive' } },
        select: { id: true },
      });
      if (m) return true;
    }
    return false;
  }
  if (v.record.externalId) {
    const e = await prisma.deal.findUnique({
      where: {
        deal_external_uq: {
          externalSource: v.record.externalSource ?? externalSource,
          externalId: v.record.externalId,
        },
      },
      select: { id: true },
    });
    if (e) return true;
  }
  return false;
}

// Shared rule: only overwrite fields that have a non-null value in the
// source row. Blank cells should never null out existing data — that's
// the spec's "blank cell does not overwrite a populated DB field" rule.
function pickNonNull<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out as Partial<T>;
}

// When updating a record matched by name or email — rather than by
// externalId — we deliberately leave externalId/externalSource off the
// update payload. Otherwise an incidental email collision with a
// pre-existing manual Contact would silently bind that Contact to the
// importing CRM's identity, and a later re-import via externalId would
// hit a different row than the user expects. Stamping external identity
// is reserved for the externalId match path (or fresh creates).
async function upsertCompany(
  prisma: PrismaClient | Prisma.TransactionClient,
  record: CompanyImportRecord,
  externalSource: string,
): Promise<{ id: number; created: boolean }> {
  const fields = {
    name: record.name,
    industry: record.industry,
    website: record.website,
    phone: record.phone,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    city: record.city,
    state: record.state,
    postalCode: record.postalCode,
    notes: record.notes,
  };
  // 1) Match by externalId (if mapped) — idempotent re-import path. Only
  //    this branch updates externalId/externalSource on existing rows.
  if (record.externalId) {
    const existing = await prisma.company.findUnique({
      where: {
        company_external_uq: {
          externalSource: record.externalSource ?? externalSource,
          externalId: record.externalId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      const updateData = pickNonNull(fields);
      await prisma.company.update({ where: { id: existing.id }, data: updateData });
      return { id: existing.id, created: false };
    }
  }
  // 2) Match by case-insensitive name. Update content fields only —
  //    don't stamp external identity onto a name-matched record.
  const byName = await prisma.company.findFirst({
    where: { name: { equals: record.name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (byName) {
    const updateData = pickNonNull(fields);
    await prisma.company.update({ where: { id: byName.id }, data: updateData });
    return { id: byName.id, created: false };
  }
  // 3) Create. New rows get external identity if the CSV provided it.
  const created = await prisma.company.create({
    data: {
      ...fields,
      externalId: record.externalId,
      externalSource: record.externalId
        ? record.externalSource ?? externalSource
        : null,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

async function upsertContact(
  prisma: PrismaClient | Prisma.TransactionClient,
  record: ContactImportRecord,
  companyId: number | null,
  externalSource: string,
): Promise<{ id: number; created: boolean }> {
  const fields = {
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    phone: record.phone,
    title: record.title,
    linkedin: record.linkedin,
    notes: record.notes,
    companyId,
  };
  if (record.externalId) {
    const existing = await prisma.contact.findUnique({
      where: {
        contact_external_uq: {
          externalSource: record.externalSource ?? externalSource,
          externalId: record.externalId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      const updateData = pickNonNull(fields);
      await prisma.contact.update({ where: { id: existing.id }, data: updateData });
      return { id: existing.id, created: false };
    }
  }
  // Email match — content-only update; do not bind external identity.
  if (record.email) {
    const byEmail = await prisma.contact.findFirst({
      where: { email: { equals: record.email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (byEmail) {
      const updateData = pickNonNull(fields);
      await prisma.contact.update({ where: { id: byEmail.id }, data: updateData });
      return { id: byEmail.id, created: false };
    }
  }
  const created = await prisma.contact.create({
    data: {
      ...fields,
      externalId: record.externalId,
      externalSource: record.externalId
        ? record.externalSource ?? externalSource
        : null,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

async function upsertDeal(
  prisma: PrismaClient | Prisma.TransactionClient,
  record: DealImportRecord,
  refs: { companyId: number | null; primaryContactId: number | null; stageId: number },
  externalSource: string,
): Promise<{ id: number; created: boolean }> {
  const baseData = {
    title: record.title,
    amount: record.amount ?? 0,
    currency: record.currency ?? 'USD',
    probability: record.probability ?? 0,
    expectedCloseDate: record.expectedCloseDate
      ? new Date(record.expectedCloseDate + 'T00:00:00.000Z')
      : null,
    stageId: refs.stageId,
    companyId: refs.companyId,
    primaryContactId: refs.primaryContactId,
    externalId: record.externalId,
    externalSource: record.externalId
      ? record.externalSource ?? externalSource
      : null,
  };
  if (record.externalId) {
    const existing = await prisma.deal.findUnique({
      where: {
        deal_external_uq: {
          externalSource: record.externalSource ?? externalSource,
          externalId: record.externalId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      const updateData = pickNonNull(baseData);
      await prisma.deal.update({ where: { id: existing.id }, data: updateData });
      return { id: existing.id, created: false };
    }
  }
  // Deals don't have a natural-key match like Company.name or Contact.email,
  // so without externalId we always create. Matching by title would risk
  // collapsing two real, distinct deals with the same name.
  const created = await prisma.deal.create({ data: baseData, select: { id: true } });
  return { id: created.id, created: true };
}

// Build the error-CSV content for /jobs/:id/errors.csv. Stitches the
// original row back together (using the stored CSV) and appends an
// `_error_reason` column with the joined reasons. We rebuild from the
// original CSV rather than the validated record so the user sees their
// raw input — that's the form they'll edit and re-upload.
export async function buildErrorCsv(
  sourceFile: string,
  errors: ValidationError[],
): Promise<string> {
  const { headers, rows } = await loadCsvFromStorage(sourceFile);
  const errorsByRow = new Map<number, string[]>();
  for (const e of errors) {
    if (e.row <= 1) continue; // header / file-level errors don't map to a row
    const existing = errorsByRow.get(e.row) ?? [];
    existing.push(e.reason);
    errorsByRow.set(e.row, existing);
  }
  const out: string[] = [];
  // csvEscape neutralizes leading formula chars (`=`, `+`, `-`, `@`, tab, CR,
  // LF) by prefixing an apostrophe — required because the error CSV is
  // downloaded by users and double-clicked into Excel/Sheets/Numbers, where
  // a cell starting with `=` would otherwise execute as a formula.
  out.push([...headers, '_error_reason'].map(csvEscape).join(','));
  rows.forEach((row, idx) => {
    const rowNumber = idx + 2;
    const reasons = errorsByRow.get(rowNumber);
    if (!reasons || reasons.length === 0) return;
    const cells = headers.map((h) => csvEscape(row[h] ?? ''));
    cells.push(csvEscape(reasons.join('; ')));
    out.push(cells.join(','));
  });
  return out.join('\r\n') + '\r\n';
}
