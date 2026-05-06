export type {
  UserDto,
  StageDto,
  SessionDto,
  CustomFieldDefinitionDto,
  CustomFieldEntity,
  CustomFieldType,
  CustomFieldOption,
  CustomFieldOptionsConfig,
  CustomFieldValuesMap,
  ListFilter,
  ListFilterOp,
  ListPrefs,
  TaggableEntity,
  TagDto,
  TagWithCountsDto,
  WebhookEvent,
  WebhookEndpointDto,
  WebhookDeliveryDto,
  ApiTokenDto,
  ApiTokenScope,
} from '@pipelineflow/shared';

import type { CustomFieldValuesMap, TagDto } from '@pipelineflow/shared';

export interface CompanyDto {
  id: number;
  name: string;
  industry: string | null;
  website: string | null;
  size: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
  logoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  geocodedAt: string | null;
  // The exact formatted address string Mapbox geocoded. The UI compares
  // this to the current address to flag staleness — see CompanyDetail.
  geocodedAddress: string | null;
  // 'pending' while a geocode job is queued/running, 'failed' after a
  // permanent failure. Null = idle (never tried or last run succeeded).
  geocodingStatus: 'pending' | 'failed' | null;
  geocodingError: string | null;
  tags?: TagDto[];
  customFields?: CustomFieldValuesMap;
  createdAt: string;
  updatedAt: string;
}

export interface ContactDto {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  linkedin: string | null;
  notes: string | null;
  companyId: number | null;
  company: { id: number; name: string } | null;
  tags?: TagDto[];
  customFields?: CustomFieldValuesMap;
  createdAt: string;
  updatedAt: string;
}

export interface StageRef {
  id: number;
  name: string;
  color: string;
  order: number;
  isWon: boolean;
  isLost: boolean;
}

export interface DealDto {
  id: number;
  title: string;
  amount: number;
  currency: string;
  probability: number;
  expectedCloseDate: string | null;
  stageId: number;
  stage: StageRef | null;
  companyId: number | null;
  company: { id: number; name: string } | null;
  primaryContactId: number | null;
  primaryContact: { id: number; fullName: string } | null;
  ownerId: number;
  owner: { id: number; name: string; avatarColor: string } | null;
  tags: TagDto[];
  stageChangedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  weightedValue: number;
  customFields?: CustomFieldValuesMap;
}

export interface TaskDto {
  id: number;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: 'pending' | 'completed' | 'pending_review' | 'dismissed';
  completedAt: string | null;
  dealId: number | null;
  deal: { id: number; title: string } | null;
  assignedTo: number | null;
  assignee: { id: number; name: string; avatarColor: string } | null;
  sourceMeetingId?: number | null;
  sourceActionItemText?: string | null;
  autoExtracted?: boolean;
  customerCommitment?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDto {
  id: number;
  content: string;
  // Polymorphic owner — exactly one of dealId/companyId/contactId is set.
  dealId: number | null;
  companyId: number | null;
  contactId: number | null;
  meetingId: number | null;
  source: 'manual' | 'meeting_summary' | 'ai_extracted';
  // Nullable when the original author was deleted (FK set to null).
  createdBy: number | null;
  author: { id: number; name: string; avatarColor: string; avatarUrl: string | null } | null;
  isPinned: boolean;
  createdAt: string;
}

export interface MeetingAttendeeDto {
  id: number;
  email: string;
  name: string | null;
  responseStatus: string | null;
  isOrganizer: boolean;
  contact: { id: number; firstName: string; lastName: string } | null;
  user: { id: number; name: string } | null;
}

export interface MeetingDto {
  id: number;
  calendarEventId: string;
  title: string;
  description: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  organizerEmail: string;
  organizer: { id: number; name: string; avatarColor: string } | null;
  primaryContactId: number | null;
  primaryContact: { id: number; firstName: string; lastName: string } | null;
  primaryDealId: number | null;
  primaryDeal: { id: number; title: string } | null;
  primaryCompanyId: number | null;
  primaryCompany: { id: number; name: string } | null;
  linkStatus: 'unlinked' | 'suggested' | 'confirmed' | 'rejected' | string;
  linkConfidence: number | null;
  linkMethod: string | null;
  recordingUrl: string | null;
  summaryDocUrl: string | null;
  summaryExcerpt: string | null;
  transcriptDocUrl: string | null;
  artifactsProcessedAt: string | null;
  artifactsPartial: boolean;
  attendees: MeetingAttendeeDto[];
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentDto {
  id: number;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  dealId: number | null;
  taskId: number | null;
  uploadedBy: number;
  uploader: { id: number; name: string } | null;
  uploadedAt: string;
}

export interface ActivityDto {
  id: number;
  kind: string;
  summary: string;
  meta: string | null;
  dealId: number;
  actor: { id: number; name: string; avatarColor: string; avatarUrl: string | null } | null;
  createdAt: string;
}
