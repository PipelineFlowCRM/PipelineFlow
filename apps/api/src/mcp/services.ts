import { Prisma, type User } from '@prisma/client';
import {
  companyCreateSchema,
  companyUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
  dealCreateSchema,
  dealMoveSchema,
  dealUpdateSchema,
  noteCreateSchema,
  noteUpdateSchema,
  tagCreateSchema,
  tagUpdateSchema,
  taskCreateSchema,
  taskUpdateSchema,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { HttpError } from '../lib/error.js';
import {
  applyCreateDefaults,
  loadCustomFieldValues,
  loadCustomFieldValuesFor,
  writeCustomFieldValues,
} from '../lib/customFields.js';
import {
  loadEntityTags,
  loadEntityTagsFor,
  setEntityTags,
} from '../lib/tags.js';
import { computeDestinationOrder } from '../lib/boardOrder.js';
import { emitWebhookEvent, emitWithSnapshot } from '../lib/webhooks.js';
import {
  snapshotCompanyById,
  snapshotContactById,
  snapshotDealById,
  snapshotTaskById,
} from '../lib/webhookSnapshots.js';
import {
  enqueueGoogleContactsPushDeleteForLinks,
  enqueueGoogleContactsPushUpsertIfConnected,
} from '../integrations/google/enqueuePushIfConnected.js';
import {
  activityDto,
  attachmentDto,
  companyDto,
  contactDto,
  dealDto,
  noteDto,
  stageDto,
  tagDto,
  taskDto,
} from '../lib/serialize.js';

// ─── Shared helpers ─────────────────────────────────────────────────────────

const dealInclude = {
  stage: true, company: true, primaryContact: true, owner: true,
} satisfies Prisma.DealInclude;

async function nextTopBoardOrder(tx: Prisma.TransactionClient, stageId: number) {
  const agg = await tx.deal.aggregate({ _min: { boardOrder: true }, where: { stageId } });
  const min = agg._min.boardOrder;
  return min == null ? 0 : min - 1;
}

// Soft cap on list-style endpoints. The MCP layer surfaces a `limit`
// param too, but this stops a callable tool from dragging the whole
// pipeline into a single response when the agent forgets to paginate.
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

function clampLimit(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(LIST_MAX_LIMIT, Math.trunc(n)));
}

// Single-tenant app: any authenticated user can act on any deal. The
// service layer takes the actor explicitly so audit / activity rows
// attribute correctly even though there's no per-row ACL to enforce.
export interface ActorContext {
  user: User;
}

// ─── Read services ──────────────────────────────────────────────────────────

export async function listDeals(input: {
  q?: string;
  stageId?: number;
  ownerId?: number;
  limit?: number;
}) {
  const limit = clampLimit(input.limit);
  const q = (input.q ?? '').trim();
  const where: Prisma.DealWhereInput = {
    ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  };
  const deals = await prisma.deal.findMany({
    where,
    include: dealInclude,
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  const ids = deals.map((d) => d.id);
  const cfMap = await loadCustomFieldValues(prisma, 'DEAL', ids);
  const tagMap = await loadEntityTags(prisma, 'DEAL', ids);
  return {
    deals: deals.map((d) => ({
      ...dealDto(d),
      tags: tagMap.get(d.id) ?? [],
      customFields: cfMap.get(d.id) ?? {},
    })),
    totalReturned: deals.length,
    limit,
  };
}

export async function getDeal(id: number) {
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      ...dealInclude,
      notes: {
        include: { author: true },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      },
      tasks: { include: { assignee: true, deal: true }, orderBy: { dueDate: 'asc' } },
      attachments: { include: { uploader: true }, orderBy: { uploadedAt: 'desc' } },
      activities: { include: { actor: true }, orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });
  if (!deal) throw new HttpError(404, 'Deal not found');
  const [cf, tags] = await Promise.all([
    loadCustomFieldValuesFor(prisma, 'DEAL', deal.id),
    loadEntityTagsFor(prisma, 'DEAL', deal.id),
  ]);
  return {
    deal: { ...dealDto(deal), tags, customFields: cf },
    notes: deal.notes.map(noteDto),
    tasks: deal.tasks.map(taskDto),
    attachments: deal.attachments.map(attachmentDto),
    activities: deal.activities.map(activityDto),
  };
}

export async function listCompanies(input: { q?: string; limit?: number }) {
  const limit = clampLimit(input.limit);
  const q = (input.q ?? '').trim();
  const companies = await prisma.company.findMany({
    where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return {
    companies: await Promise.all(companies.map((c) => companyDto(c))),
    totalReturned: companies.length,
    limit,
  };
}

export async function getCompany(id: number) {
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) throw new HttpError(404, 'Company not found');
  return { company: await companyDto(company) };
}

export async function listContacts(input: { q?: string; companyId?: number; limit?: number }) {
  const limit = clampLimit(input.limit);
  const q = (input.q ?? '').trim();
  const where: Prisma.ContactWhereInput = {
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
  };
  const contacts = await prisma.contact.findMany({
    where,
    include: { company: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return {
    contacts: contacts.map((c) => contactDto(c)),
    totalReturned: contacts.length,
    limit,
  };
}

export async function getContact(id: number) {
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: { company: true },
  });
  if (!contact) throw new HttpError(404, 'Contact not found');
  return { contact: contactDto(contact) };
}

export async function listTasks(input: {
  status?: 'pending' | 'completed';
  dealId?: number;
  assignedTo?: number;
  limit?: number;
}) {
  const limit = clampLimit(input.limit);
  const where: Prisma.TaskWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.dealId ? { dealId: input.dealId } : {}),
    ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
  };
  const tasks = await prisma.task.findMany({
    where,
    include: { deal: true, assignee: true },
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    take: limit,
  });
  return {
    tasks: tasks.map((t) => taskDto(t)),
    totalReturned: tasks.length,
    limit,
  };
}

export async function listStages() {
  const stages = await prisma.pipelineStage.findMany({ orderBy: { order: 'asc' } });
  return { stages: stages.map((s) => stageDto(s)) };
}

export async function listTags() {
  const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
  return { tags: tags.map(tagDto) };
}

// Cross-entity search. Same surface as the /api/search endpoint — useful
// to a chat agent that has a string and doesn't yet know whether it's a
// company, contact, or deal title.
export async function searchAll(input: { q: string; limit?: number }) {
  const limit = clampLimit(input.limit);
  // The tool schema enforces q.min(1); no empty-string guard needed.
  const q = input.q.trim();
  const [deals, companies, contacts] = await Promise.all([
    prisma.deal.findMany({
      where: { title: { contains: q, mode: 'insensitive' } },
      include: dealInclude,
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.company.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.contact.findMany({
      where: {
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: { company: true },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }),
  ]);
  return {
    deals: deals.map((d) => dealDto(d)),
    companies: await Promise.all(companies.map((c) => companyDto(c))),
    contacts: contacts.map((c) => contactDto(c)),
  };
}

// ─── Write services ─────────────────────────────────────────────────────────

export async function createDeal(input: unknown, ctx: ActorContext) {
  const data = dealCreateSchema.parse(input);
  const deal = await prisma.$transaction(async (tx) => {
    const boardOrder = await nextTopBoardOrder(tx, data.stageId);
    const created = await tx.deal.create({
      data: {
        title: data.title,
        amount: new Prisma.Decimal(data.amount),
        currency: data.currency,
        probability: data.probability,
        expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : null,
        stageId: data.stageId,
        companyId: data.companyId ?? null,
        primaryContactId: data.primaryContactId ?? null,
        ownerId: ctx.user.id,
        boardOrder,
      },
      include: dealInclude,
    });
    if (data.tagIds && data.tagIds.length > 0) {
      await setEntityTags(tx, 'DEAL', created.id, data.tagIds);
    }
    await tx.activity.create({
      data: {
        dealId: created.id,
        kind: 'created',
        summary: `Deal created in ${created.stage.name}`,
        actorId: ctx.user.id,
      },
    });
    await writeCustomFieldValues(tx, 'DEAL', created.id, data.customFields, {
      enforceRequired: true,
    });
    await applyCreateDefaults(tx, 'DEAL', created.id, data.customFields);
    return created;
  });
  await emitWithSnapshot('deal.created', () => snapshotDealById(deal.id));
  const [cf, tags] = await Promise.all([
    loadCustomFieldValuesFor(prisma, 'DEAL', deal.id),
    loadEntityTagsFor(prisma, 'DEAL', deal.id),
  ]);
  return { deal: { ...dealDto(deal), tags, customFields: cf } };
}

export async function updateDeal(id: number, input: unknown, ctx: ActorContext) {
  const data = dealUpdateSchema.parse(input);
  const out = await prisma.$transaction(async (tx) => {
    const existing = await tx.deal.findUnique({ where: { id }, include: { stage: true } });
    if (!existing) throw new HttpError(404, 'Deal not found');
    const update: Prisma.DealUpdateInput = {};
    if (data.title != null) update.title = data.title;
    if (data.amount != null) update.amount = new Prisma.Decimal(data.amount);
    if (data.currency != null) update.currency = data.currency;
    if (data.probability != null) update.probability = data.probability;
    if ('expectedCloseDate' in data)
      update.expectedCloseDate = data.expectedCloseDate ? new Date(data.expectedCloseDate) : null;
    if (data.companyId !== undefined)
      update.company = data.companyId ? { connect: { id: data.companyId } } : { disconnect: true };
    if (data.primaryContactId !== undefined)
      update.primaryContact = data.primaryContactId
        ? { connect: { id: data.primaryContactId } }
        : { disconnect: true };
    let stageChanged = false;
    if (data.stageId != null && data.stageId !== existing.stageId) {
      update.stage = { connect: { id: data.stageId } };
      update.stageChangedAt = new Date();
      update.boardOrder = await nextTopBoardOrder(tx, data.stageId);
      stageChanged = true;
    }
    const updated = await tx.deal.update({
      where: { id }, data: update, include: dealInclude,
    });
    if (data.tagIds !== undefined) await setEntityTags(tx, 'DEAL', id, data.tagIds);
    if (data.customFields !== undefined) {
      await writeCustomFieldValues(tx, 'DEAL', id, data.customFields, { enforceRequired: false });
    }
    if (stageChanged) {
      const summary = updated.stage.isWon
        ? `Marked as won (${existing.stage?.name ?? '?'} → ${updated.stage.name})`
        : updated.stage.isLost
          ? `Marked as lost (${existing.stage?.name ?? '?'} → ${updated.stage.name})`
          : `Moved ${existing.stage?.name ?? '?'} → ${updated.stage.name}`;
      const kind = updated.stage.isWon ? 'deal_won' : updated.stage.isLost ? 'deal_lost' : 'stage_changed';
      await tx.activity.create({
        data: { dealId: updated.id, kind, summary, actorId: ctx.user.id },
      });
      const terminal = updated.stage.isWon || updated.stage.isLost;
      if (terminal && !existing.stage?.isWon && !existing.stage?.isLost) {
        await tx.deal.update({
          where: { id: updated.id },
          data: { probability: updated.stage.isWon ? 100 : 0, closedAt: new Date() },
        });
      } else if (!terminal && (existing.stage?.isWon || existing.stage?.isLost)) {
        await tx.deal.update({ where: { id: updated.id }, data: { closedAt: null } });
      }
    } else {
      await tx.activity.create({
        data: {
          dealId: updated.id,
          kind: 'field_updated',
          summary: 'Deal details updated',
          actorId: ctx.user.id,
        },
      });
    }
    const fresh = await tx.deal.findUnique({ where: { id }, include: dealInclude });
    const wasTerminal = !!(existing.stage?.isWon || existing.stage?.isLost);
    const enteredWon = stageChanged && updated.stage.isWon && !wasTerminal;
    const enteredLost = stageChanged && updated.stage.isLost && !wasTerminal;
    return { fresh: fresh!, stageChanged, enteredWon, enteredLost };
  });
  const snap = await snapshotDealById(out.fresh.id);
  if (snap) {
    await emitWebhookEvent({ eventType: 'deal.updated', data: snap });
    if (out.stageChanged) await emitWebhookEvent({ eventType: 'deal.stage_changed', data: snap });
    if (out.enteredWon) await emitWebhookEvent({ eventType: 'deal.won', data: snap });
    if (out.enteredLost) await emitWebhookEvent({ eventType: 'deal.lost', data: snap });
  }
  const [cf, tags] = await Promise.all([
    loadCustomFieldValuesFor(prisma, 'DEAL', out.fresh.id),
    loadEntityTagsFor(prisma, 'DEAL', out.fresh.id),
  ]);
  return { deal: { ...dealDto(out.fresh), tags, customFields: cf } };
}

export async function moveDeal(id: number, input: unknown, ctx: ActorContext) {
  const { stageId, position } = dealMoveSchema.parse(input);
  const out = await prisma.$transaction(async (tx) => {
    const existing = await tx.deal.findUnique({ where: { id }, include: { stage: true } });
    if (!existing) throw new HttpError(404, 'Deal not found');
    const newStage = await tx.pipelineStage.findUnique({ where: { id: stageId } });
    if (!newStage) throw new HttpError(400, 'Invalid stage');
    const stageChanged = existing.stageId !== stageId;
    const enteringTerminal =
      stageChanged && (newStage.isWon || newStage.isLost) &&
      !(existing.stage?.isWon || existing.stage?.isLost);
    const leavingTerminal =
      stageChanged && !(newStage.isWon || newStage.isLost) &&
      (existing.stage?.isWon || existing.stage?.isLost);
    const destDeals = await tx.deal.findMany({
      where: { stageId, id: { not: id } },
      orderBy: [{ boardOrder: 'asc' }, { id: 'desc' }],
      select: { id: true },
    });
    const { targetIndex, orderedIds } = computeDestinationOrder(
      destDeals.map((d) => d.id), id, position,
    );
    const moveData: Prisma.DealUpdateInput = {
      boardOrder: targetIndex,
      ...(stageChanged
        ? {
            stage: { connect: { id: stageId } },
            stageChangedAt: new Date(),
            probability: newStage.isWon ? 100 : newStage.isLost ? 0 : existing.probability,
            ...(enteringTerminal ? { closedAt: new Date() } : {}),
            ...(leavingTerminal ? { closedAt: null } : {}),
          }
        : {}),
    };
    const moved = await tx.deal.update({ where: { id }, data: moveData, include: dealInclude });
    for (const [i, dealId] of orderedIds.entries()) {
      if (dealId === id) continue;
      await tx.deal.update({ where: { id: dealId }, data: { boardOrder: i } });
    }
    if (stageChanged) {
      const srcDeals = await tx.deal.findMany({
        where: { stageId: existing.stageId },
        orderBy: [{ boardOrder: 'asc' }, { id: 'desc' }],
        select: { id: true },
      });
      for (const [i, d] of srcDeals.entries()) {
        await tx.deal.update({ where: { id: d.id }, data: { boardOrder: i } });
      }
      const summary = newStage.isWon
        ? `Marked as won (${existing.stage?.name ?? '?'} → ${newStage.name})`
        : newStage.isLost
          ? `Marked as lost (${existing.stage?.name ?? '?'} → ${newStage.name})`
          : `Moved ${existing.stage?.name ?? '?'} → ${newStage.name}`;
      const kind = newStage.isWon ? 'deal_won' : newStage.isLost ? 'deal_lost' : 'stage_changed';
      await tx.activity.create({
        data: { dealId: id, kind, summary, actorId: ctx.user.id },
      });
    }
    const wasTerminal = !!(existing.stage?.isWon || existing.stage?.isLost);
    const enteredWon = stageChanged && newStage.isWon && !wasTerminal;
    const enteredLost = stageChanged && newStage.isLost && !wasTerminal;
    return { moved, stageChanged, enteredWon, enteredLost };
  });
  const snap = await snapshotDealById(out.moved.id);
  if (snap) {
    await emitWebhookEvent({ eventType: 'deal.updated', data: snap });
    if (out.stageChanged) await emitWebhookEvent({ eventType: 'deal.stage_changed', data: snap });
    if (out.enteredWon) await emitWebhookEvent({ eventType: 'deal.won', data: snap });
    if (out.enteredLost) await emitWebhookEvent({ eventType: 'deal.lost', data: snap });
  }
  const tags = await loadEntityTagsFor(prisma, 'DEAL', out.moved.id);
  return { deal: { ...dealDto(out.moved), tags } };
}

export async function deleteDeal(id: number) {
  const snap = await snapshotDealById(id);
  if (!snap) throw new HttpError(404, 'Deal not found');
  const cascadingTasks = await prisma.task.findMany({
    where: { dealId: id }, select: { id: true },
  });
  const taskSnapshots = await Promise.all(
    cascadingTasks.map((t) => snapshotTaskById(t.id)),
  );
  await prisma.$transaction(async (tx) => {
    await tx.customFieldValue.deleteMany({ where: { entityType: 'DEAL', entityId: id } });
    await tx.tagAttachment.deleteMany({ where: { entityType: 'DEAL', entityId: id } });
    await tx.deal.delete({ where: { id } });
  });
  await emitWebhookEvent({ eventType: 'deal.deleted', data: { id, snapshot: snap } });
  for (const taskSnap of taskSnapshots) {
    if (!taskSnap) continue;
    await emitWebhookEvent({
      eventType: 'task.deleted', data: { id: taskSnap.id, snapshot: taskSnap },
    });
  }
  return { id, deleted: true };
}

// ─── Companies ──────────────────────────────────────────────────────────────

export async function createCompany(input: unknown) {
  const data = companyCreateSchema.parse(input);
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.company.create({
      data: {
        name: data.name,
        industry: data.industry ?? null,
        website: data.website ?? null,
        size: data.size ?? null,
        phone: data.phone ?? null,
        addressLine1: data.addressLine1 ?? null,
        addressLine2: data.addressLine2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        postalCode: data.postalCode ?? null,
        notes: data.notes ?? null,
        logoUrl: data.logoUrl ?? null,
      },
    });
    if (data.tagIds && data.tagIds.length > 0) {
      await setEntityTags(tx, 'COMPANY', c.id, data.tagIds);
    }
    await writeCustomFieldValues(tx, 'COMPANY', c.id, data.customFields, {
      enforceRequired: true,
    });
    await applyCreateDefaults(tx, 'COMPANY', c.id, data.customFields);
    return c;
  });
  await emitWithSnapshot('company.created', () => snapshotCompanyById(created.id));
  return { company: await companyDto(created) };
}

export async function updateCompany(id: number, input: unknown) {
  const data = companyUpdateSchema.parse(input);
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.company.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Company not found');
    const update: Prisma.CompanyUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.industry !== undefined) update.industry = data.industry;
    if (data.website !== undefined) update.website = data.website;
    if (data.size !== undefined) update.size = data.size;
    if (data.phone !== undefined) update.phone = data.phone;
    if (data.addressLine1 !== undefined) update.addressLine1 = data.addressLine1;
    if (data.addressLine2 !== undefined) update.addressLine2 = data.addressLine2;
    if (data.city !== undefined) update.city = data.city;
    if (data.state !== undefined) update.state = data.state;
    if (data.postalCode !== undefined) update.postalCode = data.postalCode;
    if (data.notes !== undefined) update.notes = data.notes;
    if (data.logoUrl !== undefined) update.logoUrl = data.logoUrl;
    const c = await tx.company.update({ where: { id }, data: update });
    if (data.tagIds !== undefined) await setEntityTags(tx, 'COMPANY', id, data.tagIds);
    if (data.customFields !== undefined) {
      await writeCustomFieldValues(tx, 'COMPANY', id, data.customFields, { enforceRequired: false });
    }
    return c;
  });
  await emitWithSnapshot('company.updated', () => snapshotCompanyById(updated.id));
  return { company: await companyDto(updated) };
}

export async function deleteCompany(id: number) {
  const snap = await snapshotCompanyById(id);
  if (!snap) throw new HttpError(404, 'Company not found');
  await prisma.$transaction(async (tx) => {
    await tx.customFieldValue.deleteMany({ where: { entityType: 'COMPANY', entityId: id } });
    await tx.tagAttachment.deleteMany({ where: { entityType: 'COMPANY', entityId: id } });
    await tx.company.delete({ where: { id } });
  });
  await emitWebhookEvent({ eventType: 'company.deleted', data: { id, snapshot: snap } });
  return { id, deleted: true };
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export async function createContact(input: unknown) {
  const data = contactCreateSchema.parse(input);
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.contact.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email ?? null,
        phone: data.phone ?? null,
        title: data.title ?? null,
        linkedin: data.linkedin ?? null,
        notes: data.notes ?? null,
        companyId: data.companyId ?? null,
      },
      include: { company: true },
    });
    if (data.tagIds && data.tagIds.length > 0) {
      await setEntityTags(tx, 'CONTACT', c.id, data.tagIds);
    }
    await writeCustomFieldValues(tx, 'CONTACT', c.id, data.customFields, {
      enforceRequired: true,
    });
    await applyCreateDefaults(tx, 'CONTACT', c.id, data.customFields);
    return c;
  });
  await emitWithSnapshot('contact.created', () => snapshotContactById(created.id));
  await enqueueGoogleContactsPushUpsertIfConnected(created.id);
  return { contact: contactDto(created) };
}

export async function updateContact(id: number, input: unknown) {
  const data = contactUpdateSchema.parse(input);
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.contact.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Contact not found');
    const update: Prisma.ContactUpdateInput = {};
    if (data.firstName !== undefined) update.firstName = data.firstName;
    if (data.lastName !== undefined) update.lastName = data.lastName;
    if (data.email !== undefined) update.email = data.email;
    if (data.phone !== undefined) update.phone = data.phone;
    if (data.title !== undefined) update.title = data.title;
    if (data.linkedin !== undefined) update.linkedin = data.linkedin;
    if (data.notes !== undefined) update.notes = data.notes;
    if (data.companyId !== undefined) {
      update.company = data.companyId
        ? { connect: { id: data.companyId } }
        : { disconnect: true };
    }
    const c = await tx.contact.update({ where: { id }, data: update, include: { company: true } });
    if (data.tagIds !== undefined) await setEntityTags(tx, 'CONTACT', id, data.tagIds);
    if (data.customFields !== undefined) {
      await writeCustomFieldValues(tx, 'CONTACT', id, data.customFields, { enforceRequired: false });
    }
    return c;
  });
  await emitWithSnapshot('contact.updated', () => snapshotContactById(updated.id));
  await enqueueGoogleContactsPushUpsertIfConnected(updated.id);
  return { contact: contactDto(updated) };
}

export async function deleteContact(id: number) {
  const snap = await snapshotContactById(id);
  if (!snap) throw new HttpError(404, 'Contact not found');
  // Capture link rows for the cascade — same reason as the REST handler.
  const googleLinks = await prisma.contactGoogleLink.findMany({
    where: { contactId: id },
    select: { googleAccountId: true, resourceName: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.customFieldValue.deleteMany({ where: { entityType: 'CONTACT', entityId: id } });
    await tx.tagAttachment.deleteMany({ where: { entityType: 'CONTACT', entityId: id } });
    await tx.contact.delete({ where: { id } });
  });
  await emitWebhookEvent({ eventType: 'contact.deleted', data: { id, snapshot: snap } });
  await enqueueGoogleContactsPushDeleteForLinks(googleLinks);
  return { id, deleted: true };
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export async function createTask(input: unknown, ctx: ActorContext) {
  const data = taskCreateSchema.parse(input);
  const created = await prisma.task.create({
    data: {
      title: data.title,
      description: data.description ?? null,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      dealId: data.dealId ?? null,
      assignedTo: data.assignedTo ?? null,
    },
    include: { deal: true, assignee: true },
  });
  if (created.dealId) {
    await prisma.activity.create({
      data: {
        dealId: created.dealId,
        kind: 'task_added',
        summary: `Task added: ${created.title}`,
        actorId: ctx.user.id,
      },
    });
  }
  await emitWithSnapshot('task.created', () => snapshotTaskById(created.id));
  return { task: taskDto(created) };
}

export async function updateTask(id: number, input: unknown, ctx: ActorContext) {
  const data = taskUpdateSchema.parse(input);
  const out = await prisma.$transaction(async (tx) => {
    const existing = await tx.task.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Task not found');
    const update: Prisma.TaskUpdateInput = {};
    if (data.title !== undefined) update.title = data.title;
    if (data.description !== undefined) update.description = data.description;
    if (data.dueDate !== undefined) update.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.dealId !== undefined) {
      update.deal = data.dealId ? { connect: { id: data.dealId } } : { disconnect: true };
    }
    if (data.assignedTo !== undefined) {
      update.assignee = data.assignedTo
        ? { connect: { id: data.assignedTo } }
        : { disconnect: true };
    }
    let completedTransition = false;
    if (data.status !== undefined && data.status !== existing.status) {
      update.status = data.status;
      update.completedAt = data.status === 'completed' ? new Date() : null;
      completedTransition = data.status === 'completed';
    }
    const updated = await tx.task.update({
      where: { id }, data: update, include: { deal: true, assignee: true },
    });
    if (completedTransition && updated.dealId) {
      await tx.activity.create({
        data: {
          dealId: updated.dealId,
          kind: 'task_completed',
          summary: `Task completed: ${updated.title}`,
          actorId: ctx.user.id,
        },
      });
    }
    return updated;
  });
  await emitWithSnapshot('task.updated', () => snapshotTaskById(out.id));
  return { task: taskDto(out) };
}

export async function deleteTask(id: number) {
  const snap = await snapshotTaskById(id);
  if (!snap) throw new HttpError(404, 'Task not found');
  await prisma.task.delete({ where: { id } });
  await emitWebhookEvent({ eventType: 'task.deleted', data: { id, snapshot: snap } });
  return { id, deleted: true };
}

// ─── Notes ──────────────────────────────────────────────────────────────────

export async function createNote(input: unknown, ctx: ActorContext) {
  const data = noteCreateSchema.parse(input);
  const created = await prisma.note.create({
    data: {
      content: data.content,
      dealId: data.dealId ?? null,
      companyId: data.companyId ?? null,
      contactId: data.contactId ?? null,
      createdBy: ctx.user.id,
    },
    include: { author: true },
  });
  if (created.dealId != null) {
    await prisma.activity.create({
      data: {
        dealId: created.dealId,
        kind: 'note_added',
        summary: 'Note added',
        actorId: ctx.user.id,
      },
    });
  }
  return { note: noteDto(created) };
}

export async function updateNote(id: number, input: unknown) {
  const data = noteUpdateSchema.parse(input);
  const updated = await prisma.note.update({
    where: { id },
    data: {
      ...(data.content !== undefined ? { content: data.content } : {}),
      ...(data.isPinned !== undefined ? { isPinned: data.isPinned } : {}),
    },
    include: { author: true },
  });
  return { note: noteDto(updated) };
}

export async function deleteNote(id: number) {
  await prisma.note.delete({ where: { id } });
  return { id, deleted: true };
}

// ─── Tags ───────────────────────────────────────────────────────────────────

export async function createTag(input: unknown) {
  const data = tagCreateSchema.parse(input);
  const created = await prisma.tag.create({
    data: { name: data.name, color: data.color },
  });
  return { tag: tagDto(created) };
}

export async function updateTag(id: number, input: unknown) {
  const data = tagUpdateSchema.parse(input);
  const updated = await prisma.tag.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.color !== undefined ? { color: data.color } : {}),
    },
  });
  return { tag: tagDto(updated) };
}

export async function deleteTag(id: number) {
  // Cascade on TagAttachment removes references; the rest of the entity rows survive.
  await prisma.tag.delete({ where: { id } });
  return { id, deleted: true };
}
