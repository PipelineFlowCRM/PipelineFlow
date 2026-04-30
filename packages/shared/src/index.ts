import { z } from 'zod';

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
export const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
] as const;

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;

const trimToNull = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

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
});
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export const contactUpdateSchema = contactCreateSchema.partial();
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

// ─── Tag ─────────────────────────────────────────────────────────────────────
export const tagSchema = z.object({
  name: z.string().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#94a3b8'),
});
export type TagInput = z.infer<typeof tagSchema>;

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
  tagNames: z.array(z.string().min(1).max(40)).default([]),
});
export type DealCreateInput = z.infer<typeof dealCreateSchema>;
export const dealUpdateSchema = dealCreateSchema.partial();
export type DealUpdateInput = z.infer<typeof dealUpdateSchema>;

export const dealMoveSchema = z.object({
  stageId: z.number().int().positive(),
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
export const noteCreateSchema = z.object({
  content: z.string().min(1).max(10_000).transform((v) => v.trim()),
  dealId: z.number().int().positive(),
});
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = z.object({
  content: z.string().min(1).max(10_000).transform((v) => v.trim()),
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
