import type {
  User, Deal, Task, Note, Activity, Attachment, Company, Contact, Tag, PipelineStage,
} from '@prisma/client';
// Note: `Tag` is still imported because tagDto serializes raw Tag rows for
// polymorphic hydration in lib/tags.ts.
import { resolveImageRef } from './s3.js';

export const userDto = async (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatarColor: u.avatarColor,
  avatarUrl: await resolveImageRef(u.avatarUrl),
  theme: u.theme as 'system' | 'light' | 'dark',
  createdAt: u.createdAt.toISOString(),
});

export const stageDto = (s: PipelineStage) => ({
  id: s.id,
  name: s.name,
  color: s.color,
  order: s.order,
  isWon: s.isWon,
  isLost: s.isLost,
});

export const tagDto = (t: Tag) => ({
  id: t.id,
  name: t.name,
  color: t.color,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const companyDto = async (c: Company) => ({
  id: c.id,
  name: c.name,
  industry: c.industry,
  website: c.website,
  size: c.size,
  phone: c.phone,
  addressLine1: c.addressLine1,
  addressLine2: c.addressLine2,
  city: c.city,
  state: c.state,
  postalCode: c.postalCode,
  notes: c.notes,
  logoUrl: await resolveImageRef(c.logoUrl),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const contactDto = (
  c: Contact & { company?: { id: number; name: string } | null },
) => ({
  id: c.id,
  firstName: c.firstName,
  lastName: c.lastName,
  fullName: `${c.firstName} ${c.lastName}`.trim(),
  email: c.email,
  phone: c.phone,
  title: c.title,
  linkedin: c.linkedin,
  notes: c.notes,
  companyId: c.companyId,
  company: c.company ? { id: c.company.id, name: c.company.name } : null,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

type DealRich = Deal & {
  stage?: PipelineStage | null;
  company?: Company | null;
  primaryContact?: Contact | null;
  owner?: User | null;
};

// `tags` and `customFields` are composed at the route level (same pattern as
// customFields — they live in their own polymorphic tables and the route is
// the natural place to fan out hydration). DealDto consumers see them on the
// response body, just not from this serializer.
export const dealDto = (d: DealRich) => ({
  id: d.id,
  title: d.title,
  amount: Number(d.amount),
  currency: d.currency,
  probability: d.probability,
  expectedCloseDate: d.expectedCloseDate ? d.expectedCloseDate.toISOString().slice(0, 10) : null,
  stageId: d.stageId,
  stage: d.stage ? stageDto(d.stage) : null,
  companyId: d.companyId,
  company: d.company ? { id: d.company.id, name: d.company.name } : null,
  primaryContactId: d.primaryContactId,
  primaryContact: d.primaryContact
    ? {
        id: d.primaryContact.id,
        fullName: `${d.primaryContact.firstName} ${d.primaryContact.lastName}`,
      }
    : null,
  ownerId: d.ownerId,
  owner: d.owner ? { id: d.owner.id, name: d.owner.name, avatarColor: d.owner.avatarColor } : null,
  stageChangedAt: d.stageChangedAt.toISOString(),
  closedAt: d.closedAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  weightedValue: Number(d.amount) * (d.probability / 100),
});

export const taskDto = (
  t: Task & { deal?: { id: number; title: string } | null; assignee?: User | null },
) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
  status: t.status as 'pending' | 'completed',
  completedAt: t.completedAt?.toISOString() ?? null,
  dealId: t.dealId,
  deal: t.deal ? { id: t.deal.id, title: t.deal.title } : null,
  assignedTo: t.assignedTo,
  assignee: t.assignee
    ? { id: t.assignee.id, name: t.assignee.name, avatarColor: t.assignee.avatarColor }
    : null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const noteDto = (
  n: Note & { author?: { id: number; name: string; avatarColor: string } | null },
) => ({
  id: n.id,
  content: n.content,
  dealId: n.dealId,
  createdBy: n.createdBy,
  author: n.author ?? null,
  createdAt: n.createdAt.toISOString(),
});

export const attachmentDto = (
  a: Attachment & { uploader?: { id: number; name: string } | null },
) => ({
  id: a.id,
  filename: a.filename,
  contentType: a.contentType,
  sizeBytes: a.sizeBytes,
  dealId: a.dealId,
  taskId: a.taskId,
  uploadedBy: a.uploadedBy,
  uploader: a.uploader ?? null,
  uploadedAt: a.uploadedAt.toISOString(),
});

export const activityDto = (
  a: Activity & { actor?: { id: number; name: string; avatarColor: string } | null },
) => ({
  id: a.id,
  kind: a.kind,
  summary: a.summary,
  meta: a.meta,
  dealId: a.dealId,
  actor: a.actor ?? null,
  createdAt: a.createdAt.toISOString(),
});
