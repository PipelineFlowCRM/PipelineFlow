import type {
  User, Deal, Task, Note, Activity, Attachment, Company, Contact, Tag, PipelineStage,
  Meeting, MeetingAttendee,
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
  // The status string union widened to include 'pending_review' / 'dismissed'
  // when the auto-extraction pipeline lands. Keeping the cast loose so
  // routes that still typed against the legacy literal pair don't trip.
  status: t.status as 'pending' | 'completed' | 'pending_review' | 'dismissed',
  completedAt: t.completedAt?.toISOString() ?? null,
  dealId: t.dealId,
  deal: t.deal ? { id: t.deal.id, title: t.deal.title } : null,
  assignedTo: t.assignedTo,
  assignee: t.assignee
    ? { id: t.assignee.id, name: t.assignee.name, avatarColor: t.assignee.avatarColor }
    : null,
  // Meeting-extracted task provenance. Null on every legacy task; populated
  // only by the artifact watcher's action-item materializer. The web UI
  // uses these to render the "From meeting · Accept · Reject" affordance.
  sourceMeetingId: t.sourceMeetingId,
  sourceActionItemText: t.sourceActionItemText,
  autoExtracted: t.autoExtracted,
  customerCommitment: t.customerCommitment,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const noteDto = (
  n: Note & { author?: { id: number; name: string; avatarColor: string } | null },
) => ({
  id: n.id,
  content: n.content,
  dealId: n.dealId,
  companyId: n.companyId,
  contactId: n.contactId,
  meetingId: n.meetingId,
  source: n.source,
  createdBy: n.createdBy,
  author: n.author ?? null,
  createdAt: n.createdAt.toISOString(),
});

// Meeting summary projection — what the deal/contact page renders as the
// meeting card. Includes the three artifact URLs (the headline feature
// of this slice), the link confidence + status (drives the "needs review"
// badge), and the attendee list for context. The full audit trail and
// MeetingLinkAudit rows aren't in this shape; the meeting detail endpoint
// surfaces those when the rep opens a meeting.
export const meetingDto = (
  m: Meeting & {
    organizer?: { id: number; name: string; avatarColor: string } | null;
    attendees?: (MeetingAttendee & {
      contact?: { id: number; firstName: string; lastName: string } | null;
      user?: { id: number; name: string } | null;
    })[];
    primaryContact?: Contact | null;
    primaryDeal?: { id: number; title: string } | null;
    primaryCompany?: { id: number; name: string } | null;
  },
) => ({
  id: m.id,
  calendarEventId: m.calendarEventId,
  title: m.title,
  description: m.description,
  scheduledStart: m.scheduledStart.toISOString(),
  scheduledEnd: m.scheduledEnd.toISOString(),
  status: m.status,
  organizerEmail: m.organizerEmail,
  organizer: m.organizer ?? null,
  // The matcher's chosen anchor — surfaced flat so the UI doesn't need
  // to hop into the relations to render the "linked to <deal>" badge.
  primaryContactId: m.primaryContactId,
  primaryContact: m.primaryContact
    ? {
        id: m.primaryContact.id,
        firstName: m.primaryContact.firstName,
        lastName: m.primaryContact.lastName,
      }
    : null,
  primaryDealId: m.primaryDealId,
  primaryDeal: m.primaryDeal ? { id: m.primaryDeal.id, title: m.primaryDeal.title } : null,
  primaryCompanyId: m.primaryCompanyId,
  primaryCompany: m.primaryCompany ?? null,
  linkStatus: m.linkStatus,
  linkConfidence: m.linkConfidence ? Number(m.linkConfidence) : null,
  linkMethod: m.linkMethod,
  // The point of the whole feature: one-click open of recording, summary,
  // transcript. URLs are nullable — a meeting that hasn't completed yet
  // (or whose Gemini summary is still cooking) just won't have them.
  recordingUrl: m.recordingUrl,
  summaryDocUrl: m.summaryDocUrl,
  summaryExcerpt: m.summaryExcerpt,
  transcriptDocUrl: m.transcriptDocUrl,
  artifactsProcessedAt: m.artifactsProcessedAt?.toISOString() ?? null,
  artifactsPartial: m.artifactsPartial,
  attendees: (m.attendees ?? []).map((a) => ({
    id: a.id,
    email: a.email,
    name: a.name,
    responseStatus: a.responseStatus,
    isOrganizer: a.isOrganizer,
    contact: a.contact
      ? { id: a.contact.id, firstName: a.contact.firstName, lastName: a.contact.lastName }
      : null,
    user: a.user ? { id: a.user.id, name: a.user.name } : null,
  })),
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
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
