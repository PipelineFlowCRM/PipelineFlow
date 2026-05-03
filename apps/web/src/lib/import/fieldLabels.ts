import type { EntityType } from './api';

// User-facing labels for canonical fields. Lives client-side so the
// dropdown isn't another network call — and the canonical list is small
// enough that drift between client and server is easy to keep in sync
// (the synonyms.ts file is the source of truth for which fields exist).
//
// Entity-aware lookup: some canonical-field keys are reused across
// entities (`title` is "Job title" on Contact and "Deal title" on Deal,
// `phone` is the company switchboard or the contact's mobile). The
// `fieldLabel` helper takes the entity type so the dropdown shows the
// right human label even when the underlying key is shared.

const SHARED_LABELS: Record<string, string> = {
  phone: 'Phone',
  notes: 'Notes',
  externalId: 'External ID',
  externalSource: 'External source',
};

const COMPANY_LABELS: Record<string, string> = {
  ...SHARED_LABELS,
  name: 'Name',
  industry: 'Industry',
  website: 'Website',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  state: 'State',
  postalCode: 'Postal code',
};

const CONTACT_LABELS: Record<string, string> = {
  ...SHARED_LABELS,
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  title: 'Job title',
  linkedin: 'LinkedIn',
  companyName: 'Company name',
  companyExternalId: 'Company external ID',
};

const DEAL_LABELS: Record<string, string> = {
  ...SHARED_LABELS,
  title: 'Deal title',
  amount: 'Amount',
  currency: 'Currency',
  probability: 'Probability',
  expectedCloseDate: 'Expected close date',
  stageName: 'Stage',
  companyName: 'Company name',
  companyExternalId: 'Company external ID',
  primaryContactEmail: 'Primary contact email',
};

const TABLES: Record<EntityType, Record<string, string>> = {
  company: COMPANY_LABELS,
  contact: CONTACT_LABELS,
  deal: DEAL_LABELS,
};

export function fieldLabel(field: string, entityType: EntityType): string {
  return TABLES[entityType][field] ?? field;
}
