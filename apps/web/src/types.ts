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
  status: 'pending' | 'completed';
  completedAt: string | null;
  dealId: number | null;
  deal: { id: number; title: string } | null;
  assignedTo: number | null;
  assignee: { id: number; name: string; avatarColor: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDto {
  id: number;
  content: string;
  dealId: number;
  createdBy: number;
  author: { id: number; name: string; avatarColor: string } | null;
  createdAt: string;
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
  actor: { id: number; name: string; avatarColor: string } | null;
  createdAt: string;
}
