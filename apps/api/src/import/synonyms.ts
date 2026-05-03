// Canonical-field synonym table used by the auto-mapper. Keys are canonical
// fields ("entity.field"); values are the column-name aliases the mapper
// will accept. Comparison is case-insensitive and ignores non-alphanumerics
// (see normalizeHeader in mapping.ts).
//
// Adding a new alias here is a code change, not a migration — the mapper
// reloads the table on every call. Keep aliases conservative: they back the
// auto-pre-fill, and a too-broad synonym pushes the user to manually
// override every wrong guess. When in doubt, leave a column unmapped and
// let the user pick.
export type CanonicalField = string;

export const CANONICAL_FIELDS_BY_ENTITY: Record<
  'company' | 'contact' | 'deal',
  CanonicalField[]
> = {
  company: [
    'name',
    'industry',
    'website',
    'phone',
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'postalCode',
    'notes',
    'externalId',
    'externalSource',
  ],
  contact: [
    'firstName',
    'lastName',
    'email',
    'phone',
    'title',
    'linkedin',
    'notes',
    'companyName',
    'companyExternalId',
    'externalId',
    'externalSource',
  ],
  deal: [
    'title',
    'amount',
    'currency',
    'probability',
    'expectedCloseDate',
    'stageName',
    'companyName',
    'companyExternalId',
    'primaryContactEmail',
    'externalId',
    'externalSource',
  ],
};

// Each entity gets its own synonym map so an ambiguous alias like "name"
// can mean Company.name on a Companies import and Deal.title on a Deals
// import. Within an entity the values are normalized at lookup time.
export const SYNONYMS: Record<
  'company' | 'contact' | 'deal',
  Record<CanonicalField, string[]>
> = {
  company: {
    name: [
      'name',
      'company',
      'company name',
      'organization',
      'organization name',
      'org',
      'org name',
      'account',
      'account name',
      'business',
      'business name',
    ],
    industry: ['industry', 'vertical', 'sector'],
    website: ['website', 'url', 'web', 'web site', 'domain', 'site'],
    phone: ['phone', 'phone number', 'telephone', 'tel', 'work phone'],
    addressLine1: ['address', 'address 1', 'address line 1', 'street', 'street address'],
    addressLine2: ['address 2', 'address line 2', 'suite', 'unit'],
    city: ['city', 'town', 'locality'],
    state: ['state', 'region', 'province'],
    postalCode: ['postal code', 'zip', 'zip code', 'postcode'],
    notes: ['notes', 'description', 'comments', 'about'],
    externalId: ['id', 'external id', 'external_id', 'pipedrive id', 'hubspot id', 'organization id', 'org id'],
    externalSource: ['source', 'crm', 'origin'],
  },
  contact: {
    firstName: ['first name', 'firstname', 'given name', 'fname', 'first', 'forename'],
    lastName: ['last name', 'lastname', 'surname', 'family name', 'lname', 'last'],
    email: ['email', 'email address', 'e-mail', 'primary email', 'work email'],
    phone: ['phone', 'phone number', 'mobile', 'cell', 'tel', 'telephone', 'work phone'],
    title: ['title', 'job title', 'role', 'position'],
    linkedin: ['linkedin', 'linkedin url', 'linkedin profile'],
    notes: ['notes', 'description', 'about', 'bio', 'comments'],
    companyName: ['company', 'company name', 'organization', 'organization name', 'employer', 'account'],
    companyExternalId: ['company id', 'organization id', 'org id', 'account id'],
    externalId: ['id', 'person id', 'contact id', 'external id', 'pipedrive id', 'hubspot id'],
    externalSource: ['source', 'crm', 'origin'],
  },
  deal: {
    title: ['title', 'name', 'deal name', 'deal title', 'opportunity', 'opportunity name'],
    amount: ['amount', 'value', 'deal value', 'price', 'revenue', 'total'],
    currency: ['currency', 'currency code'],
    probability: ['probability', 'win probability', 'likelihood', 'confidence'],
    expectedCloseDate: ['expected close date', 'close date', 'expected close', 'closing date'],
    stageName: ['stage', 'stage name', 'pipeline stage', 'status'],
    companyName: ['company', 'company name', 'organization', 'organization name', 'account'],
    companyExternalId: ['company id', 'organization id', 'org id', 'account id'],
    primaryContactEmail: ['contact email', 'primary contact email', 'person email', 'email'],
    externalId: ['id', 'deal id', 'opportunity id', 'external id'],
    externalSource: ['source', 'crm', 'origin'],
  },
};
