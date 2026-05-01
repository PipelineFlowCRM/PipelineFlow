// Builds the canonical `data` payload sent inside the webhook envelope for
// each entity. Uses the same DTO shapes the REST API returns, plus the
// entity's tags and custom-field values — those are conceptually part of
// the record, just stored polymorphically. Relations are embedded one
// level deep (matching the answer to interview Q5).
//
// All helpers are designed to run *after* the route's transaction has
// committed. They re-read the entity to capture the post-mutation state,
// which is what consumers expect from `*.created` / `*.updated`. For
// `*.deleted` the route must build the snapshot *before* it deletes the
// row, since the relations would otherwise be gone — see snapshotDealById
// vs. the delete-time helpers in the route layer.
import type { User } from '@prisma/client';
import { prisma } from '../db.js';
import {
  companyDto, contactDto, dealDto, taskDto,
} from './serialize.js';
import { loadCustomFieldValuesFor } from './customFields.js';
import { loadEntityTagsFor } from './tags.js';

const dealInclude = {
  stage: true, company: true, primaryContact: true, owner: true,
} as const;

const contactInclude = { company: true } as const;
const taskInclude = { deal: true, assignee: true } as const;

// Webhook payloads expose more user identity than the REST API does — the
// public DTOs return {id, name, avatarColor} for embedded users, but
// downstream automations (CRMs, Slack notifiers, custom routers) need the
// email to map back to their own user records. Kept local to this module
// so we don't accidentally leak email through unrelated API responses.
function webhookUserRef(u: Pick<User, 'id' | 'name' | 'email' | 'avatarColor'> | null | undefined) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, avatarColor: u.avatarColor };
}

export async function snapshotDealById(id: number) {
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: dealInclude,
  });
  if (!deal) return null;
  const [tags, customFields] = await Promise.all([
    loadEntityTagsFor(prisma, 'DEAL', deal.id),
    loadCustomFieldValuesFor(prisma, 'DEAL', deal.id),
  ]);
  // Spread dealDto first so the email-bearing owner ref overwrites the
  // public-shape one — the rest of the dto (stage, company, etc.) stays
  // identical to what the REST API returns.
  return {
    ...dealDto(deal),
    owner: webhookUserRef(deal.owner),
    tags,
    customFields,
  };
}

export async function snapshotCompanyById(id: number) {
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return null;
  const [dto, tags, customFields] = await Promise.all([
    companyDto(company),
    loadEntityTagsFor(prisma, 'COMPANY', company.id),
    loadCustomFieldValuesFor(prisma, 'COMPANY', company.id),
  ]);
  return { ...dto, tags, customFields };
}

export async function snapshotContactById(id: number) {
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: contactInclude,
  });
  if (!contact) return null;
  const [tags, customFields] = await Promise.all([
    loadEntityTagsFor(prisma, 'CONTACT', contact.id),
    loadCustomFieldValuesFor(prisma, 'CONTACT', contact.id),
  ]);
  return { ...contactDto(contact), tags, customFields };
}

export async function snapshotTaskById(id: number) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: taskInclude,
  });
  if (!task) return null;
  return {
    ...taskDto(task),
    assignee: webhookUserRef(task.assignee),
  };
}
