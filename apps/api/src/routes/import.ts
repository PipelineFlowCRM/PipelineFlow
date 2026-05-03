import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import busboy from 'busboy';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { logger } from '../lib/logger.js';
import { dispositionHeader } from '../lib/s3.js';
import { parseCsv, previewRows } from '../import/parser.js';
import { suggestMapping, canonicalFieldsFor, type EntityType } from '../import/mapping.js';
import { applyPreset, detectPreset, PRESETS } from '../import/presets/index.js';
import { deleteImportSource, getImportSource, putImportSource } from '../import/storage.js';
import { runImport, buildErrorCsv, type RunSummary } from '../import/job-runner.js';
import type { ValidationError } from '../import/validators/types.js';

export const importRouter = Router();
importRouter.use(requireAuth);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Pulls a single file field out of a multipart/form-data request body and
// returns its bytes plus the form fields. Limited to one file (we reject
// extras) and capped at 10 MB — a 50k-row CSV typically lands around 5 MB,
// so this gives a comfortable safety margin without blowing the request
// memory ceiling. Form fields like `entityType` ride alongside the file.
async function readMultipart(req: Request): Promise<{
  filename: string;
  buffer: Buffer;
  fields: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const contentType = req.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      reject(new HttpError(400, 'Content-Type must be multipart/form-data'));
      return;
    }
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    const fields: Record<string, string> = {};
    let captured = false;
    let filename = '';
    const chunks: Buffer[] = [];
    let truncated = false;

    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (_name, file, info) => {
      if (captured) {
        // Multiple files in one upload — we only ever import one CSV at a
        // time. Drain the extra so busboy resolves.
        file.resume();
        return;
      }
      captured = true;
      filename = info.filename || 'upload.csv';
      file.on('data', (d: Buffer) => chunks.push(d));
      file.on('limit', () => {
        truncated = true;
      });
      file.on('end', () => {
        // No-op; the close handler resolves the outer promise.
      });
    });
    bb.on('error', (err) => reject(err));
    bb.on('close', () => {
      if (truncated) {
        reject(new HttpError(413, 'File too large (max 10 MB)'));
        return;
      }
      if (!captured) {
        reject(new HttpError(400, 'No file uploaded'));
        return;
      }
      resolve({ filename, buffer: Buffer.concat(chunks), fields });
    });
    req.pipe(bb);
  });
}

// All entityType inputs must be one of these literals. Rejecting anything
// else keeps the resolver / validator dispatch tables exhaustive.
const entityTypeSchema = z.enum(['company', 'contact', 'deal']);

// POST /api/import/upload — multipart upload. Returns the parsed headers,
// a sample of the first 5 rows, the entity-aware suggested mapping, the
// detected preset (if any), and the canonical-field options the wizard
// will render in its dropdowns. Writes an `ImportJob` row in `pending`
// status so re-fetching is cheap.
importRouter.post(
  '/upload',
  asyncHandler(async (req, res) => {
    const { filename, buffer, fields } = await readMultipart(req);
    if (buffer.length === 0) throw new HttpError(400, 'Uploaded file is empty');
    const entityType = entityTypeSchema.parse(fields.entityType ?? '');

    const text = buffer.toString('utf-8');
    const parsed = parseCsv(text);
    if (parsed.errors.length > 0) {
      // Surface a parse failure synchronously — the wizard can't proceed
      // without headers. We don't write an ImportJob row in this case;
      // there is nothing to resume.
      throw new HttpError(400, parsed.errors[0]?.reason ?? 'Could not parse CSV');
    }
    if (parsed.headers.length === 0) {
      throw new HttpError(400, 'CSV has no header row');
    }

    const detected = detectPreset(parsed.headers);
    const baseMapping = detected
      ? applyPreset(detected.preset, parsed.headers)
      : Object.fromEntries(parsed.headers.map((h) => [h, null] as const));
    // If the detected preset's entityType disagrees with the user's pick,
    // ignore the preset's mapping — surfacing a Companies preset on a
    // Contact import would silently mis-map the columns. Suggest fields
    // for the chosen entity instead.
    const presetForEntity = detected?.preset.entityType === entityType ? detected : null;
    const suggested = presetForEntity
      ? baseMapping
      : suggestMapping(parsed.headers, entityType);

    // Sequence: pre-generate the job id, push to S3 first, *then* insert
    // the row in one go. Pre-existing rows in the DB use cuid format
    // (Prisma's default); new rows use UUID. Either is fine — the
    // column is just a string. Failure modes:
    //   - S3 put fails  → no row, no orphaned S3 object. User retries.
    //   - DB create fails after S3 put → best-effort delete the S3 file
    //     so the bucket doesn't accumulate orphans. If the cleanup also
    //     fails, the comment in storage.ts explains the lifecycle gap.
    const jobId = randomUUID();
    const sourceKey = await putImportSource(jobId, buffer);
    let job: { id: string };
    try {
      job = await prisma.importJob.create({
        data: {
          id: jobId,
          userId: req.user!.id,
          entityType,
          filename,
          sourceFile: sourceKey,
          status: 'pending',
          mapping: suggested,
          presetUsed: presetForEntity?.preset.key ?? null,
          totalRows: parsed.rows.length,
        },
        select: { id: true },
      });
    } catch (err) {
      // Roll back the S3 put so we don't pile up orphans on every
      // failed import attempt.
      await deleteImportSource(sourceKey).catch(() => {});
      throw err;
    }

    res.json({
      jobId: job.id,
      headers: parsed.headers,
      sampleRows: previewRows(parsed, 5),
      totalRows: parsed.rows.length,
      detectedPreset: presetForEntity
        ? {
            key: presetForEntity.preset.key,
            sourceLabel: presetForEntity.preset.sourceLabel,
            entityType: presetForEntity.preset.entityType,
            score: presetForEntity.score,
            externalSource: presetForEntity.preset.externalSource,
          }
        : null,
      suggestedMapping: suggested,
      canonicalFields: canonicalFieldsFor(entityType),
    });
  }),
);

const runBodySchema = z.object({
  entityType: entityTypeSchema,
  mapping: z.record(z.string(), z.string().nullable()),
  stageMapping: z.record(z.string(), z.number().int().positive()).optional(),
  externalSource: z.string().min(1).max(60).optional(),
});

async function loadJobForUser(jobIdRaw: unknown, userId: number) {
  const jobId = typeof jobIdRaw === 'string' && jobIdRaw.length > 0 ? jobIdRaw : null;
  if (!jobId) throw new HttpError(404, 'Import job not found');
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== userId) {
    throw new HttpError(404, 'Import job not found');
  }
  return job;
}

// The `errors` JSON column now holds `{ summary, errors }` for jobs
// touched by dry-run/commit. Earlier code stored a bare array of
// errors; this helper accepts both shapes so an in-flight upgrade
// doesn't lose old jobs' error reports.
function readPersistedRun(blob: unknown): { summary: RunSummary | null; errors: ValidationError[] } {
  if (!blob) return { summary: null, errors: [] };
  if (Array.isArray(blob)) {
    return { summary: null, errors: blob as ValidationError[] };
  }
  if (typeof blob === 'object' && blob !== null) {
    const b = blob as { summary?: RunSummary; errors?: ValidationError[] };
    return { summary: b.summary ?? null, errors: b.errors ?? [] };
  }
  return { summary: null, errors: [] };
}

// Statuses where a job is still considered editable. A completed or
// failed job is locked — re-running it would either double-count writes
// or rewind the audit trail. The user starts a new import instead.
const EDITABLE_STATUSES = ['pending', 'validating', 'validated'] as const;

importRouter.post(
  '/:jobId/dry-run',
  asyncHandler(async (req, res) => {
    const job = await loadJobForUser(req.params.jobId, req.user!.id);
    const body = runBodySchema.parse(req.body);
    if (body.entityType !== (job.entityType as EntityType)) {
      // Rejecting an entity-type swap mid-flight matches the wizard's
      // "change entity type by restarting" rule and keeps the stored
      // ImportJob row coherent (status + counts are entity-typed).
      throw new HttpError(400, 'Cannot change entity type after upload');
    }
    // Race-safe transition (mirrors the commit path below). Two
    // concurrent dry-runs (a user clicks "Run dry-run again" while the
    // first is mid-flight) used to both proceed and produce
    // nondeterministic counts as their final updates raced. The
    // conditional updateMany only flips the status when the row is
    // still in an editable state — the loser bails with a 409.
    const transition = await prisma.importJob.updateMany({
      where: { id: job.id, status: { in: [...EDITABLE_STATUSES] } },
      data: {
        status: 'validating',
        mapping: body.mapping,
        stageMapping: body.stageMapping ?? Prisma.JsonNull,
      },
    });
    if (transition.count === 0) {
      throw new HttpError(409, `Cannot dry-run a job in status "${job.status}"`);
    }
    const result = await runImport(prisma, job.sourceFile, {
      entityType: body.entityType,
      mapping: body.mapping,
      stageMapping: body.stageMapping,
      externalSource: body.externalSource,
      commit: false,
    });
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: 'validated',
        totalRows: result.summary.totalRows,
        createdRows: 0,
        updatedRows: 0,
        errorRows: result.summary.willError,
        // Persist the full dry-run output as a single blob so the
        // resume endpoint can rehydrate Step 3 without recomputing.
        // `errors` was already capped at 1 000 in the runner.
        errors: { summary: result.summary, errors: result.errors } as unknown as object,
      },
    });
    res.json({ summary: result.summary, errors: result.errors });
  }),
);

importRouter.post(
  '/:jobId/commit',
  asyncHandler(async (req, res) => {
    const job = await loadJobForUser(req.params.jobId, req.user!.id);
    const body = runBodySchema.parse(req.body);
    if (body.entityType !== (job.entityType as EntityType)) {
      throw new HttpError(400, 'Cannot change entity type after upload');
    }
    // Race-safe state transition: the conditional updateMany only matches
    // a row whose status is still editable. A second concurrent commit
    // (double-clicked button, or a tab + a curl) sees the same `job` row
    // and races into this updateMany — only one of them changes a row,
    // the other gets `count: 0` and bails. Without this we'd run
    // runImport twice and double-write everything.
    const transition = await prisma.importJob.updateMany({
      where: {
        id: job.id,
        status: { in: [...EDITABLE_STATUSES] },
      },
      data: {
        status: 'committing',
        mapping: body.mapping,
        stageMapping: body.stageMapping ?? Prisma.JsonNull,
      },
    });
    if (transition.count === 0) {
      throw new HttpError(409, `Cannot commit a job in status "${job.status}"`);
    }
    let result;
    try {
      result = await runImport(prisma, job.sourceFile, {
        entityType: body.entityType,
        mapping: body.mapping,
        stageMapping: body.stageMapping,
        externalSource: body.externalSource,
        commit: true,
      });
    } catch (err) {
      await prisma.importJob.update({
        where: { id: job.id },
        data: { status: 'failed', completedAt: new Date() },
      });
      throw err;
    }
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        createdRows: result.summary.willCreate,
        updatedRows: result.summary.willUpdate,
        errorRows: result.summary.willError,
        stubCompaniesCreated: result.summary.stubCompaniesCreated,
        stubContactsCreated: result.summary.stubContactsCreated,
        errors: { summary: result.summary, errors: result.errors } as unknown as object,
      },
    });
    res.json({
      summary: result.summary,
      errors: result.errors,
      createdIds: result.createdIds ?? [],
      updatedIds: result.updatedIds ?? [],
    });
  }),
);

const listJobsQuerySchema = z.object({
  // z.coerce parses strings before applying integer/min/max so a non-
  // numeric `?limit=abc` rejects with a clean 400 instead of silently
  // becoming NaN and propagating into Prisma's `take`.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(100).optional(),
});

importRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { limit, cursor } = listJobsQuerySchema.parse(req.query);
    const jobs = await prisma.importJob.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const nextCursor = jobs.length > limit ? jobs[limit]?.id ?? null : null;
    res.json({
      jobs: jobs.slice(0, limit).map(serializeJob),
      nextCursor,
    });
  }),
);

importRouter.get(
  '/jobs/:jobId',
  asyncHandler(async (req, res) => {
    const job = await loadJobForUser(req.params.jobId, req.user!.id);
    // Resume-friendly response: re-parse the source CSV and re-derive the
    // headers, sample rows, detected preset, and canonical fields list so
    // the wizard can rehydrate Step 2 / 3 state without a fresh upload.
    let resume: {
      headers: string[];
      sampleRows: Record<string, string>[];
      totalRows: number;
      detectedPreset: ReturnType<typeof detectPreset>;
      canonicalFields: string[];
      mapping: Record<string, string | null>;
      stageMapping: Record<string, number>;
      priorRun: { summary: RunSummary; errors: ValidationError[] } | null;
    } | null = null;
    let sourceUnavailable = false;
    try {
      const buffer = await getImportSource(job.sourceFile);
      const parsed = parseCsv(buffer.toString('utf-8'));
      if (parsed.errors.length === 0 && parsed.headers.length > 0) {
        const detected = detectPreset(parsed.headers);
        const persisted = readPersistedRun(job.errors);
        resume = {
          headers: parsed.headers,
          sampleRows: previewRows(parsed, 5),
          totalRows: parsed.rows.length,
          detectedPreset: detected,
          canonicalFields: canonicalFieldsFor(job.entityType as EntityType),
          mapping: (job.mapping as Record<string, string | null>) ?? {},
          stageMapping: (job.stageMapping as Record<string, number>) ?? {},
          priorRun: persisted.summary
            ? { summary: persisted.summary, errors: persisted.errors }
            : null,
        };
      }
    } catch (err) {
      // Distinguish "source genuinely gone" (lifecycle-deleted, never
      // landed) from transient AWS / network failures. Only the former
      // should signal `resume: null` — a transient hiccup should bubble
      // up so the user can retry rather than re-upload from scratch.
      const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
      const code = e?.name ?? e?.Code ?? null;
      const status = e?.$metadata?.httpStatusCode ?? null;
      const isMissing =
        code === 'NoSuchKey' || code === 'NotFound' || status === 404 ||
        // Dev-cache miss path from storage.ts.
        (err instanceof Error && err.message.includes('not found in dev cache'));
      if (isMissing) {
        sourceUnavailable = true;
        logger.warn({ jobId: job.id, sourceFile: job.sourceFile }, 'import source missing for resume');
      } else {
        logger.error({ err, jobId: job.id }, 'failed to load import source for resume');
        throw new HttpError(503, 'Could not load the import source — try again in a moment');
      }
    }
    res.json({ job: serializeJob(job), resume, sourceUnavailable });
  }),
);

// Hard-delete a job and its S3 source file. Allowed in any status except
// `committing`, where an in-flight write would be left dangling.
// Completed/failed jobs are deletable too — the audit trail lives in
// activity logs and the imported records themselves; the job row's only
// purpose after commit is the error-CSV download. Users who want to
// keep an audit trail can simply not click Delete.
importRouter.delete(
  '/jobs/:jobId',
  asyncHandler(async (req, res) => {
    const job = await loadJobForUser(req.params.jobId, req.user!.id);
    // Both committing and validating are in-flight server work whose
    // final UPDATE would throw P2025 (record not found) if the row
    // disappeared mid-run. Refuse the delete and ask the user to wait.
    if (job.status === 'committing' || job.status === 'validating') {
      throw new HttpError(
        409,
        `Cannot delete a job while it is ${job.status}`,
      );
    }
    // Delete the DB row first; the S3 cleanup is best-effort. If the S3
    // call fails, the orphan file is reaped by the bucket's `imports/`
    // lifecycle rule (and by storage.ts's swallow-and-log behavior).
    await prisma.importJob.delete({ where: { id: job.id } });
    if (job.sourceFile) {
      await deleteImportSource(job.sourceFile);
    }
    res.json({ ok: true });
  }),
);

importRouter.get(
  '/jobs/:jobId/errors.csv',
  asyncHandler(async (req, res) => {
    const job = await loadJobForUser(req.params.jobId, req.user!.id);
    const { errors } = readPersistedRun(job.errors);
    if (errors.length === 0) {
      throw new HttpError(404, 'No errors recorded for this job');
    }
    const csv = await buildErrorCsv(job.sourceFile, errors);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set(
      'Content-Disposition',
      dispositionHeader(`import-${job.id}-errors.csv`),
    );
    res.send(csv);
  }),
);

importRouter.get(
  '/presets',
  asyncHandler(async (_req, res) => {
    res.json({
      presets: PRESETS.map((p) => ({
        key: p.key,
        sourceLabel: p.sourceLabel,
        entityType: p.entityType,
        externalSource: p.externalSource,
      })),
    });
  }),
);

function serializeJob(job: {
  id: string;
  entityType: string;
  filename: string;
  status: string;
  presetUsed: string | null;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  errorRows: number;
  stubCompaniesCreated: number;
  stubContactsCreated: number;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: job.id,
    entityType: job.entityType,
    filename: job.filename,
    status: job.status,
    presetUsed: job.presetUsed,
    totalRows: job.totalRows,
    createdRows: job.createdRows,
    updatedRows: job.updatedRows,
    errorRows: job.errorRows,
    stubCompaniesCreated: job.stubCompaniesCreated,
    stubContactsCreated: job.stubContactsCreated,
    startedAt: job.startedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}
