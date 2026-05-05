import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { companyCreateSchema, companyUpdateSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { companyDto, contactDto, dealDto, noteDto } from '../lib/serialize.js';
import {
  applyCreateDefaults,
  loadCustomFieldValues,
  loadCustomFieldValuesFor,
  writeCustomFieldValues,
} from '../lib/customFields.js';
import {
  applyCustomFieldFilters,
  buildBuiltinWhere,
  parseFiltersQueryParam,
  parseTagIdsQueryParam,
  splitFilters,
} from '../lib/listFilters.js';
import {
  filterEntityIdsByTags,
  loadEntityTags,
  loadEntityTagsFor,
  setEntityTags,
} from '../lib/tags.js';
import { emitWebhookEvent, emitWithSnapshot } from '../lib/webhooks.js';
import { obsoleteImageKey } from '../lib/s3.js';
import { enqueueS3Cleanup } from '../lib/queue.js';
import { kickoffEnrichment } from '../lib/enrichment/enqueue.js';
import { logger } from '../lib/logger.js';
import {
  snapshotCompanyById,
  snapshotContactById,
  snapshotDealById,
} from '../lib/webhookSnapshots.js';

export const companiesRouter = Router();
companiesRouter.use(requireAuth);

const companiesListQuerySchema = z.object({
  tagOp: z.enum(['and', 'or']).default('or'),
});

companiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const { tagOp } = companiesListQuerySchema.parse({ tagOp: req.query.tagOp });
    const tagIds = parseTagIdsQueryParam(req.query.tagIds);
    const filters = parseFiltersQueryParam(req.query.filters);
    const { builtin, cf } = splitFilters(filters);
    const cfAllowed = await applyCustomFieldFilters('COMPANY', cf);
    if (cfAllowed != null && cfAllowed.length === 0) {
      res.json({ companies: [] });
      return;
    }
    const tagAllowed = await filterEntityIdsByTags(prisma, 'COMPANY', tagIds, tagOp);
    if (tagAllowed != null && tagAllowed.length === 0) {
      res.json({ companies: [] });
      return;
    }
    let allowed: number[] | null = null;
    if (cfAllowed != null && tagAllowed != null) {
      const tagSet = new Set(tagAllowed);
      allowed = cfAllowed.filter((id) => tagSet.has(id));
      if (allowed.length === 0) {
        res.json({ companies: [] });
        return;
      }
    } else if (cfAllowed != null) {
      allowed = cfAllowed;
    } else if (tagAllowed != null) {
      allowed = tagAllowed;
    }

    const builtinWhere = buildBuiltinWhere<Prisma.CompanyWhereInput>('COMPANY', builtin);
    const where: Prisma.CompanyWhereInput = {
      ...builtinWhere,
      ...(allowed != null ? { id: { in: allowed } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };
    const companies = await prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 100,
    });
    const ids = companies.map((c) => c.id);
    const [cfMap, tagMap] = await Promise.all([
      loadCustomFieldValues(prisma, 'COMPANY', ids),
      loadEntityTags(prisma, 'COMPANY', ids),
    ]);
    const dtos = await Promise.all(
      companies.map(async (c) => ({
        ...(await companyDto(c)),
        tags: tagMap.get(c.id) ?? [],
        customFields: cfMap.get(c.id) ?? {},
      })),
    );
    res.json({ companies: dtos });
  }),
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = companyCreateSchema.parse(req.body);
    const { customFields, tagIds, ...rest } = input;
    const dup = await prisma.company.findFirst({
      where: { name: { equals: rest.name, mode: 'insensitive' } },
    });
    if (dup) {
      const [cf, tags] = await Promise.all([
        loadCustomFieldValuesFor(prisma, 'COMPANY', dup.id),
        loadEntityTagsFor(prisma, 'COMPANY', dup.id),
      ]);
      res.json({
        company: { ...(await companyDto(dup)), tags, customFields: cf },
        existed: true,
      });
      return;
    }
    try {
      const c = await prisma.$transaction(async (tx) => {
        const created = await tx.company.create({ data: rest });
        if (tagIds && tagIds.length > 0) {
          await setEntityTags(tx, 'COMPANY', created.id, tagIds);
        }
        await writeCustomFieldValues(tx, 'COMPANY', created.id, customFields, {
          enforceRequired: true,
        });
        await applyCreateDefaults(tx, 'COMPANY', created.id, customFields);
        return created;
      });
      const [cf, tags] = await Promise.all([
        loadCustomFieldValuesFor(prisma, 'COMPANY', c.id),
        loadEntityTagsFor(prisma, 'COMPANY', c.id),
      ]);
      await emitWithSnapshot('company.created', () => snapshotCompanyById(c.id));
      // Fire-and-forget enrichment kickoff. The helper is a no-op when
      // the feature is disabled or auto-on-create is off; the response
      // never waits on the enrichment, so the user sees the create
      // succeed immediately even if Anthropic is slow / down.
      kickoffEnrichment({
        companyId: c.id,
        trigger: 'auto-create',
        actorUserId: req.user?.id,
      }).catch((err) => {
        logger.error({ err, companyId: c.id }, 'auto-enrichment kickoff failed');
      });
      res.status(201).json({
        company: { ...(await companyDto(c)), tags, customFields: cf },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await prisma.company.findFirst({
          where: { name: { equals: rest.name, mode: 'insensitive' } },
        });
        if (existing) {
          const [cf, tags] = await Promise.all([
            loadCustomFieldValuesFor(prisma, 'COMPANY', existing.id),
            loadEntityTagsFor(prisma, 'COMPANY', existing.id),
          ]);
          res.json({
            company: { ...(await companyDto(existing)), tags, customFields: cf },
            existed: true,
          });
          return;
        }
      }
      throw e;
    }
  }),
);

companiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        contacts: { include: { company: true }, orderBy: [{ firstName: 'asc' }] },
        deals: {
          include: { stage: true, company: true, owner: true, primaryContact: true },
          orderBy: { updatedAt: 'desc' },
        },
        noteEntries: {
          include: { author: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!company) throw new HttpError(404, 'Company not found');
    const [cf, tags, dealTagMap] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'COMPANY', company.id),
      loadEntityTagsFor(prisma, 'COMPANY', company.id),
      loadEntityTags(prisma, 'DEAL', company.deals.map((d) => d.id)),
    ]);
    res.json({
      company: { ...(await companyDto(company)), tags, customFields: cf },
      contacts: company.contacts.map(contactDto),
      deals: company.deals.map((d) => ({
        ...dealDto(d),
        tags: dealTagMap.get(d.id) ?? [],
      })),
      notes: company.noteEntries.map(noteDto),
    });
  }),
);

companiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = companyUpdateSchema.parse(req.body);
    const { customFields, tagIds, ...rest } = input;
    // Read current logoUrl so we can detect a logo replacement and queue
    // the previous bucket object for cleanup (the schema only stores one
    // ref per company — replacements would otherwise orphan).
    const obsolete = await prisma.$transaction(async (tx) => {
      const before =
        'logoUrl' in rest
          ? await tx.company.findUnique({ where: { id }, select: { logoUrl: true } })
          : null;
      const updated = await tx.company.update({ where: { id }, data: rest });
      if (tagIds !== undefined) {
        await setEntityTags(tx, 'COMPANY', id, tagIds);
      }
      if (customFields !== undefined) {
        await writeCustomFieldValues(tx, 'COMPANY', id, customFields, {
          enforceRequired: false,
        });
      }
      return {
        updated,
        oldLogoKey: before
          ? obsoleteImageKey(before.logoUrl, rest.logoUrl ?? null)
          : null,
      };
    });
    const c = obsolete.updated;
    if (obsolete.oldLogoKey) {
      await enqueueS3Cleanup({ keys: [obsolete.oldLogoKey] });
    }
    const [cf, tags] = await Promise.all([
      loadCustomFieldValuesFor(prisma, 'COMPANY', c.id),
      loadEntityTagsFor(prisma, 'COMPANY', c.id),
    ]);
    await emitWithSnapshot('company.updated', () => snapshotCompanyById(c.id));
    res.json({ company: { ...(await companyDto(c)), tags, customFields: cf } });
  }),
);

companiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const snap = await snapshotCompanyById(id);
    // Capture the ids of every deal/contact whose FK is about to flip
    // to NULL via the schema's onDelete: SetNull. After the company
    // delete commits, we re-snapshot each (the company-shaped fields
    // will now show null) and emit a `*.updated` so receivers don't end
    // up with stale `deal.companyId` / `contact.companyId` references.
    const affectedDealIds = await prisma.deal.findMany({
      where: { companyId: id },
      select: { id: true },
    });
    const affectedContactIds = await prisma.contact.findMany({
      where: { companyId: id },
      select: { id: true },
    });
    // Read logoUrl + delete in one transaction so a concurrent PATCH
    // replacing the logo can't orphan the new key (we'd see the pre-PATCH
    // value and queue that one for cleanup, leaving the just-uploaded
    // replacement orphaned in the bucket).
    const logoKey = await prisma.$transaction(async (tx) => {
      const beforeRow = await tx.company.findUnique({
        where: { id },
        select: { logoUrl: true },
      });
      await tx.customFieldValue.deleteMany({ where: { entityType: 'COMPANY', entityId: id } });
      await tx.tagAttachment.deleteMany({ where: { entityType: 'COMPANY', entityId: id } });
      await tx.company.delete({ where: { id } });
      return obsoleteImageKey(beforeRow?.logoUrl ?? null, null);
    });
    if (logoKey) {
      await enqueueS3Cleanup({ keys: [logoKey] });
    }
    if (snap) {
      await emitWebhookEvent({
        eventType: 'company.deleted',
        data: { id, snapshot: snap },
      });
    }
    for (const { id: dealId } of affectedDealIds) {
      await emitWithSnapshot('deal.updated', () => snapshotDealById(dealId));
    }
    for (const { id: contactId } of affectedContactIds) {
      await emitWithSnapshot('contact.updated', () => snapshotContactById(contactId));
    }
    res.json({ ok: true });
  }),
);
