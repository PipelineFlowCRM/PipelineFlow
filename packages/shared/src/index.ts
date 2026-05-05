import { z } from 'zod';
import { US_STATES } from './usStates.js';

export * from './queues.js';
export * from './enrichment.js';
export * from './usStates.js';

// ─── Auth ────────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(255),
});
export type RegisterInput = z.infer<typeof registerSchema>;

// ─── Profile ─────────────────────────────────────────────────────────────────
// `avatarUrl` accepts either an absolute http(s) URL or an S3 key in the
// `avatar/` scope returned by /uploads/presign. The DTO resolves keys to
// presigned GET URLs at read time.
const avatarRefSchema = z
  .string()
  .max(500)
  .nullable()
  .optional()
  .refine(
    (v) => v == null || /^https?:\/\//i.test(v) || /^avatar\//.test(v),
    { message: 'avatarUrl must be an http(s) URL or an avatar/ S3 key' },
  );

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  avatarUrl: avatarRefSchema,
  theme: z.enum(['system', 'light', 'dark']).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(255),
    confirmPassword: z.string().min(8).max(255),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const changeEmailSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;

// ─── Pipeline stage ──────────────────────────────────────────────────────────
export const stageSchema = z.object({
  name: z.string().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  order: z.number().int().min(0),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
});
export type StageInput = z.infer<typeof stageSchema>;

// ─── Company ─────────────────────────────────────────────────────────────────
// US_STATES + normalizeUsState now live in ./usStates.js (re-exported above)
// so the worker's enrichment apply path can import the normalizer without
// pulling in this whole module — and so the schema enum and the normalizer
// share one source of truth.

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;

const trimToNull = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

// Re-declared below the customFields block — see customFieldValuesPayloadSchema.
// Keeping the schema definition here, with a forward-declared optional field.
export const companyCreateSchema = z.object({
  name: z.string().min(1).max(200).transform((v) => v.trim()),
  industry: trimToNull(120),
  website: trimToNull(255),
  size: z.enum(COMPANY_SIZES).nullable().optional(),
  phone: trimToNull(40),
  addressLine1: trimToNull(200),
  addressLine2: trimToNull(200),
  city: trimToNull(100),
  state: z.enum(US_STATES).nullable().optional(),
  postalCode: trimToNull(20),
  notes: trimToNull(10_000),
  // Same convention as avatarUrl: absolute URL or `logo/` S3 key.
  logoUrl: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine(
      (v) => v == null || v === '' || /^https?:\/\//i.test(v) || /^logo\//.test(v),
      { message: 'logoUrl must be an http(s) URL or a logo/ S3 key' },
    ),
  tagIds: z.array(z.number().int().positive()).default([]).optional(),
  customFields: z
    .record(z.string(), z.union([
      z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
    ]))
    .optional(),
});
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;
export const companyUpdateSchema = companyCreateSchema.partial();
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

// ─── Contact ─────────────────────────────────────────────────────────────────
export const contactCreateSchema = z.object({
  firstName: z.string().min(1).max(80).transform((v) => v.trim()),
  lastName: z.string().min(1).max(80).transform((v) => v.trim()),
  email: trimToNull(255),
  phone: trimToNull(40),
  title: trimToNull(120),
  linkedin: trimToNull(255),
  notes: trimToNull(10_000),
  companyId: z.number().int().positive().nullable().optional(),
  tagIds: z.array(z.number().int().positive()).default([]).optional(),
  customFields: z
    .record(z.string(), z.union([
      z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
    ]))
    .optional(),
});
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export const contactUpdateSchema = contactCreateSchema.partial();
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

// ─── Tag ─────────────────────────────────────────────────────────────────────
export const tagCreateSchema = z.object({
  name: z.string().min(1).max(40).transform((v) => v.trim()),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#94a3b8'),
});
export type TagCreateInput = z.infer<typeof tagCreateSchema>;

export const tagUpdateSchema = z.object({
  name: z.string().min(1).max(40).transform((v) => v.trim()).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>;

// ─── Deal ────────────────────────────────────────────────────────────────────
export const dealCreateSchema = z.object({
  title: z.string().min(1).max(200).transform((v) => v.trim()),
  amount: z.number().nonnegative().default(0),
  currency: z.string().min(3).max(8).default('USD'),
  probability: z.number().int().min(0).max(100).default(0),
  expectedCloseDate: z.string().nullable().optional(), // ISO date YYYY-MM-DD
  stageId: z.number().int().positive(),
  companyId: z.number().int().positive().nullable().optional(),
  primaryContactId: z.number().int().positive().nullable().optional(),
  tagIds: z.array(z.number().int().positive()).default([]).optional(),
  customFields: z
    .record(z.string(), z.union([
      z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
    ]))
    .optional(),
});
export type DealCreateInput = z.infer<typeof dealCreateSchema>;
export const dealUpdateSchema = dealCreateSchema.partial();
export type DealUpdateInput = z.infer<typeof dealUpdateSchema>;

export const dealMoveSchema = z.object({
  stageId: z.number().int().positive(),
  position: z.number().int().min(0),
});

// ─── Task ────────────────────────────────────────────────────────────────────
export const taskCreateSchema = z.object({
  title: z.string().min(1).max(255).transform((v) => v.trim()),
  description: trimToNull(10_000),
  dueDate: z.string().nullable().optional(),
  dealId: z.number().int().positive().nullable().optional(),
  assignedTo: z.number().int().positive().nullable().optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export const taskUpdateSchema = taskCreateSchema.partial().extend({
  status: z.enum(['pending', 'completed']).optional(),
});
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

// ─── Note ────────────────────────────────────────────────────────────────────
// Polymorphic — exactly one of dealId / companyId / contactId must be set.
// The schema's CHECK constraint backs this up at the DB level; the .superRefine
// here gives the API a friendly 400 instead of a Postgres constraint error.
export const noteCreateSchema = z
  .object({
    content: z.string().min(1).max(10_000).transform((v) => v.trim()),
    dealId: z.number().int().positive().nullable().optional(),
    companyId: z.number().int().positive().nullable().optional(),
    contactId: z.number().int().positive().nullable().optional(),
  })
  .superRefine((d, ctx) => {
    const set = [d.dealId, d.companyId, d.contactId].filter((v) => v != null).length;
    if (set !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of dealId, companyId, contactId must be set',
        path: ['dealId'],
      });
    }
  });
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

// Both fields optional so callers can patch one (toggle pin) without
// resending content, or both (rename + repin). At least one must be set;
// an empty body is a no-op the API rejects with a 400.
export const noteUpdateSchema = z
  .object({
    content: z.string().min(1).max(10_000).transform((v) => v.trim()).optional(),
    isPinned: z.boolean().optional(),
  })
  .refine((d) => d.content !== undefined || d.isPinned !== undefined, {
    message: 'At least one of content or isPinned must be provided',
  });
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;

// ─── Quick lead ──────────────────────────────────────────────────────────────
export const quickLeadSchema = z.object({
  companyName: z.string().min(1).max(200),
  website: z.string().max(255).optional().nullable(),
  contactName: z.string().max(160).optional().nullable(),
  contactEmail: z.string().max(255).optional().nullable(),
  contactPhone: z.string().max(40).optional().nullable(),
});
export type QuickLeadInput = z.infer<typeof quickLeadSchema>;

// ─── Presigned upload ────────────────────────────────────────────────────────
export const presignUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024), // 50 MB cap
  scope: z.enum(['attachment', 'avatar', 'logo']),
  dealId: z.number().int().positive().nullable().optional(),
  taskId: z.number().int().positive().nullable().optional(),
  companyId: z.number().int().positive().nullable().optional(),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

// Used by /uploads/attachments to register an attachment after a successful
// PUT to S3. The key must come from a recent /uploads/presign response — the
// API rejects keys it didn't issue (see `lib/issuedKeys.ts`).
export const attachmentCreateSchema = z
  .object({
    key: z.string().min(1).max(500).regex(/^attachment\//, {
      message: 'key must be an attachment/ scope key',
    }),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(120).nullable().optional(),
    sizeBytes: z.number().int().positive().max(50 * 1024 * 1024).nullable().optional(),
    dealId: z.number().int().positive().nullable().optional(),
    taskId: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => d.dealId != null || d.taskId != null, {
    message: 'attachment must reference a deal or a task',
    path: ['dealId'],
  });
export type AttachmentCreateInput = z.infer<typeof attachmentCreateSchema>;

// ─── Stages ──────────────────────────────────────────────────────────────────
export const stagesReorderSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type StagesReorderInput = z.infer<typeof stagesReorderSchema>;

// ─── Task list query ─────────────────────────────────────────────────────────
// Strict shape for /tasks GET filters; parsed via .parse(req.query).
export const tasksListQuerySchema = z.object({
  status: z.enum(['pending', 'completed']).optional(),
  dealId: z.coerce.number().int().positive().optional(),
  mine: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  start: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
  end: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
});
export type TasksListQuery = z.infer<typeof tasksListQuerySchema>;

// ─── Custom fields ───────────────────────────────────────────────────────────
export const CUSTOM_FIELD_ENTITIES = ['CONTACT', 'COMPANY', 'DEAL'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'LONG_TEXT',
  'NUMBER',
  'MONEY',
  'DATE',
  'DATETIME',
  'EMAIL',
  'URL',
  'PHONE',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

// User-facing label for each type. Kept here so the shared package can be the
// single source of truth for type metadata.
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  TEXT: 'Text',
  LONG_TEXT: 'Long text',
  NUMBER: 'Number',
  MONEY: 'Money',
  DATE: 'Date',
  DATETIME: 'Date & time',
  EMAIL: 'Email',
  URL: 'URL',
  PHONE: 'Phone',
  BOOLEAN: 'Checkbox',
  SELECT: 'Single-select',
  MULTI_SELECT: 'Multi-select',
};

// `key` must be a stable identifier — used in API payloads, list-pref blobs,
// query params (`cf[key]=...`), and as the column key in lists. Keep it lower
// snake-case so URLs and JSON paths stay readable.
const customFieldKeyRegex = /^[a-z][a-z0-9_]{0,47}$/;
export const customFieldKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(customFieldKeyRegex, {
    message: 'key must be lowercase letters/digits/underscores, starting with a letter',
  });

// SELECT / MULTI_SELECT options. `value` is what gets stored; `label` is what
// users see. The `value` must also be a stable key (the same rules as field
// keys) so we can persist values even if the human-readable label changes.
export const customFieldOptionSchema = z.object({
  value: customFieldKeySchema,
  label: z.string().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type CustomFieldOption = z.infer<typeof customFieldOptionSchema>;

// `options` payload is type-dependent:
//   SELECT / MULTI_SELECT → { choices: CustomFieldOption[] }
//   MONEY                → { currency: 'USD' }
//   everything else      → null / omitted
export const customFieldOptionsSchema = z
  .object({
    choices: z.array(customFieldOptionSchema).max(200).optional(),
    currency: z.string().min(3).max(8).optional(),
  })
  .nullable()
  .optional();
export type CustomFieldOptionsConfig = z.infer<typeof customFieldOptionsSchema>;

// Definition CRUD. `key` is immutable after creation (renaming would orphan
// list-pref blobs and existing query strings) — `customFieldDefinitionUpdateSchema`
// drops it.
export const customFieldDefinitionCreateSchema = z
  .object({
    entityType: z.enum(CUSTOM_FIELD_ENTITIES),
    key: customFieldKeySchema,
    label: z.string().min(1).max(80).transform((v) => v.trim()),
    type: z.enum(CUSTOM_FIELD_TYPES),
    isRequired: z.boolean().default(false),
    defaultValue: z.string().max(2000).nullable().optional(),
    options: customFieldOptionsSchema,
    order: z.number().int().min(0).optional(),
  })
  .superRefine((d, ctx) => {
    const isSelect = d.type === 'SELECT' || d.type === 'MULTI_SELECT';
    if (isSelect && (!d.options?.choices || d.options.choices.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'choices'],
        message: 'Select fields must have at least one option',
      });
    }
    if (isSelect && d.options?.choices) {
      const seen = new Set<string>();
      for (const c of d.options.choices) {
        if (seen.has(c.value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['options', 'choices'],
            message: `Duplicate option value: ${c.value}`,
          });
        }
        seen.add(c.value);
      }
    }
  });
export type CustomFieldDefinitionCreateInput = z.infer<typeof customFieldDefinitionCreateSchema>;

// Update: label / required / default / options / order / isActive.
// Type and key are immutable to preserve referential integrity of stored values.
export const customFieldDefinitionUpdateSchema = z
  .object({
    label: z.string().min(1).max(80).transform((v) => v.trim()).optional(),
    isActive: z.boolean().optional(),
    isRequired: z.boolean().optional(),
    defaultValue: z.string().max(2000).nullable().optional(),
    options: customFieldOptionsSchema,
    order: z.number().int().min(0).optional(),
  })
  .superRefine((d, ctx) => {
    // The router enforces type-aware option-narrowing semantics (it knows the
    // existing type). Here we only catch the universally-broken shapes:
    // duplicate option values within a single update payload.
    if (d.options?.choices) {
      const seen = new Set<string>();
      for (const c of d.options.choices) {
        if (seen.has(c.value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['options', 'choices'],
            message: `Duplicate option value: ${c.value}`,
          });
        }
        seen.add(c.value);
      }
    }
  });
export type CustomFieldDefinitionUpdateInput = z.infer<typeof customFieldDefinitionUpdateSchema>;

export const customFieldsReorderSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES),
  ids: z.array(z.number().int().positive()).min(1).max(200),
});
export type CustomFieldsReorderInput = z.infer<typeof customFieldsReorderSchema>;

// Payload for entity create/update: a flat map of key → value. Values are
// loosely typed here (the API coerces per the definition's type before
// writing). `null` clears a value.
export const customFieldValuesPayloadSchema = z
  .record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]))
  .optional();
export type CustomFieldValuesPayload = z.infer<typeof customFieldValuesPayloadSchema>;

// ─── User list preferences ───────────────────────────────────────────────────
// Persisted shape per (userId, entityType).
//   columns        — ordered visible-column keys (built-in keys like
//                    'firstName' / 'company' or 'cf:<fieldKey>' for custom)
//   filters        — array of { key, op, value } where `key` is a built-in
//                    field name or 'cf:<fieldKey>'.
export const listFilterOpSchema = z.enum([
  'eq', 'neq', 'contains', 'starts_with',
  'gt', 'gte', 'lt', 'lte',
  'is_true', 'is_false',
  'in', 'not_in',
  'is_set', 'is_not_set',
]);
export type ListFilterOp = z.infer<typeof listFilterOpSchema>;

export const listFilterSchema = z.object({
  key: z.string().min(1).max(120),
  op: listFilterOpSchema,
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .optional(),
});
export type ListFilter = z.infer<typeof listFilterSchema>;

export const listPrefsSchema = z.object({
  columns: z.array(z.string().min(1).max(120)).max(60).default([]),
  filters: z.array(listFilterSchema).max(20).default([]),
});
export type ListPrefs = z.infer<typeof listPrefsSchema>;

export const listPrefsUpdateSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES),
  prefs: listPrefsSchema,
});
export type ListPrefsUpdateInput = z.infer<typeof listPrefsUpdateSchema>;

// ─── DTOs (response shapes) — kept loose; the API serializes Prisma rows ─────
export interface UserDto {
  id: number;
  email: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  theme: 'system' | 'light' | 'dark';
  createdAt: string;
}

export interface SessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

export interface StageDto {
  id: number;
  name: string;
  color: string;
  order: number;
  isWon: boolean;
  isLost: boolean;
}

export interface CustomFieldDefinitionDto {
  id: number;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  isActive: boolean;
  isRequired: boolean;
  defaultValue: string | null;
  options: CustomFieldOptionsConfig | null;
  order: number;
  // Count of CustomFieldValue rows referencing this definition. Drives the
  // smart-delete UI (delete vs. inactivate) and the inactive-but-still-used
  // read-only display behavior.
  valueCount: number;
  createdAt: string;
  updatedAt: string;
}

// Custom-field values returned alongside an entity. Keys are the
// definition's `key`; values are JSON-friendly (string | number | boolean |
// string[] | null).
export type CustomFieldValuesMap = Record<
  string,
  string | number | boolean | string[] | null
>;

// ─── Tag DTOs ────────────────────────────────────────────────────────────────
// TaggableEntity intentionally aliases CustomFieldEntity — the same three
// entities (CONTACT/COMPANY/DEAL) are taggable. Aliased so consumers don't
// need to know about the historical naming.
export const TAGGABLE_ENTITIES = CUSTOM_FIELD_ENTITIES;
export type TaggableEntity = CustomFieldEntity;

export interface TagDto {
  id: number;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface TagWithCountsDto extends TagDto {
  counts: {
    deals: number;
    companies: number;
    contacts: number;
    total: number;
  };
}

// ─── Webhooks ────────────────────────────────────────────────────────────────
// Catalog of every event the system can emit. Adding to this list is a
// pure code change (no migration) — the WebhookEndpoint.events column is a
// free-form Json string array, validated at the API layer against this set.
//
// Naming: `<resource>.<verb>`. The terminal-state events for deals
// (`stage_changed`, `won`, `lost`) and tasks (`completed`) are emitted in
// addition to the corresponding `*.updated`, since they're high-signal and
// would otherwise force consumers to diff the full payload.
export const WEBHOOK_EVENTS = [
  'deal.created',
  'deal.updated',
  'deal.deleted',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'company.created',
  'company.updated',
  'company.deleted',
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'task.created',
  'task.updated',
  'task.deleted',
  'task.completed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// System-emitted event used by the "Send test" button. Intentionally
// outside WEBHOOK_EVENTS so users can't subscribe to it (and so it
// doesn't show up in the form's checkbox grid). The receiver always
// gets one of these regardless of which events the endpoint subscribes
// to — let consumers branch on `type === 'webhook.test'` to ignore it.
export const WEBHOOK_TEST_EVENT = 'webhook.test' as const;
export type WebhookTestEvent = typeof WEBHOOK_TEST_EVENT;
// Union of every type a delivery row's `eventType` field might hold.
// Used by the dto so receivers parsing the delivery log don't trip on
// the test type.
export type WebhookDeliveryEventType = WebhookEvent | WebhookTestEvent;

// Grouped for UI rendering — each row in the form maps to one entity.
export const WEBHOOK_EVENT_GROUPS: { entity: string; events: WebhookEvent[] }[] = [
  {
    entity: 'Deals',
    events: [
      'deal.created',
      'deal.updated',
      'deal.deleted',
      'deal.stage_changed',
      'deal.won',
      'deal.lost',
    ],
  },
  {
    entity: 'Companies',
    events: ['company.created', 'company.updated', 'company.deleted'],
  },
  {
    entity: 'Contacts',
    events: ['contact.created', 'contact.updated', 'contact.deleted'],
  },
  {
    entity: 'Tasks',
    events: ['task.created', 'task.updated', 'task.deleted', 'task.completed'],
  },
];

const customHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9-]+$/, 'Header names: letters, digits, dashes only'),
    z
      .string()
      .min(1)
      .max(2048)
      // CRLF and NUL in header values is the classic header-injection
      // vector — undici will reject these at fetch time, but rejecting
      // them at validation time keeps the bad value from ever landing
      // in the DB.
      .regex(/^[^\r\n\0]+$/, 'Header values cannot contain newlines or null bytes'),
  )
  .refine(
    (h) => {
      // System-managed headers — refuse to let the user override these.
      const reserved = /^(content-type|user-agent|x-pipelineflow-)/i;
      return Object.keys(h).every((k) => !reserved.test(k));
    },
    { message: 'Cannot override Content-Type, User-Agent, or X-PipelineFlow-* headers' },
  );

export const webhookEndpointCreateSchema = z.object({
  name: z.string().min(1).max(120).transform((v) => v.trim()),
  // Limit to http/https. Localhost stays allowed — useful for ngrok/dev
  // tunnels — but the server-side enqueue layer can still refuse private
  // ranges in prod if we ever add SSRF hardening.
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), { message: 'URL must be http(s)' }),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  customHeaders: customHeadersSchema.nullable().optional(),
  enabled: z.boolean().default(true).optional(),
});
export type WebhookEndpointCreateInput = z.infer<typeof webhookEndpointCreateSchema>;

export const webhookEndpointUpdateSchema = webhookEndpointCreateSchema.partial();
export type WebhookEndpointUpdateInput = z.infer<typeof webhookEndpointUpdateSchema>;

// Response shape. `secret` is *only* present on create / rotate-secret
// responses — list/get omit it. Consumers must store it at create time.
export interface WebhookEndpointDto {
  id: number;
  name: string;
  url: string;
  events: WebhookEvent[];
  customHeaders: Record<string, string> | null;
  enabled: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Populated on the create + rotate responses; null elsewhere so the type
  // stays stable.
  secret?: string;
}

export interface WebhookDeliveryDto {
  id: number;
  endpointId: number;
  eventId: string;
  // Union with the test event since /endpoints/:id/test stores
  // `webhook.test` rows alongside the real ones.
  eventType: WebhookDeliveryEventType;
  status: 'pending' | 'success' | 'failed';
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

// What we send. `id` is `evt_<nanoid>` — same value across retries; clients
// dedupe on it. `data` is a full DTO with shallow embeds (one level deep).
export interface WebhookEventEnvelope<T = unknown> {
  id: string;
  type: WebhookEvent;
  createdAt: string;
  data: T;
}

// ─── API tokens (MCP / public REST) ─────────────────────────────────────────
// Bearer tokens issued for non-interactive clients. The MCP server at
// /api/mcp authenticates with these; once the public REST surface ships
// it'll share the same token type.
//
// Scopes are coarse on purpose: `read` covers list/get tools, `write`
// covers create/update/move (mutations short of deletion), and `delete`
// gates destructive ops. A token that doesn't have `delete` won't even
// see destructive tools listed when the agent calls `tools/list` — so
// well-behaved agents can't accidentally invoke them.
export const API_TOKEN_SCOPES = ['read', 'write', 'delete'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const apiTokenCreateSchema = z.object({
  name: z.string().min(1).max(120).transform((v) => v.trim()),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length),
  // Optional ISO timestamp. Omit for non-expiring tokens (still revokable
  // from the UI). When set, must be in the future.
  expiresAt: z
    .string()
    .datetime()
    .optional()
    .refine((v) => !v || new Date(v) > new Date(), {
      message: 'expiresAt must be in the future',
    }),
});
export type ApiTokenCreateInput = z.infer<typeof apiTokenCreateSchema>;

// Response shape. `secret` is *only* present on the create response —
// list/get omit it. The plaintext token is shown to the user exactly
// once and never persisted in plaintext on the server.
export interface ApiTokenDto {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  // Populated on the create response; the wire format is `pf_<id>_<secret>`.
  token?: string;
}
