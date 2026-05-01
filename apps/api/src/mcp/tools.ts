import { z, type ZodRawShape } from 'zod';
import type { ApiTokenScope } from '@pipelineflow/shared';
import * as svc from './services.js';
import type { ActorContext } from './services.js';

// One declarative shape per tool. The MCP server iterates this list and
// only registers the ones the calling token's scopes cover, so an agent
// holding a `read`-only token can't even *see* a write tool — well-
// behaved clients don't have to check scopes themselves.
//
// The handler signature stores a type-erased view (args: unknown) so
// every tool — regardless of its zod shape — can live in a single
// uniform array. The `tool()` helper bakes the proper-typed handler
// into the erased one before storage, so per-tool authoring stays
// fully typed.
export interface McpToolDef {
  name: string;
  // Shows up in `tools/list`. Keep concise — Claude reads these to pick
  // the right tool.
  description: string;
  // Gates registration. A token with `read` scope sees only `read` tools;
  // a token with `read,write` sees those plus write; etc.
  scope: ApiTokenScope;
  // Truthy means this action is destructive and irreversible. The MCP
  // server wraps these in the two-phase approval flow: first invocation
  // returns an approval token + summary; second invocation must pass the
  // approval token back. Annotates the MCP tool with `destructiveHint`
  // too so well-behaved clients also prompt before calling.
  destructive?: boolean;
  // Zod input shape (raw shape, not z.object — that's what the SDK
  // wants for `inputSchema`).
  input: ZodRawShape;
  // Receives the args (already validated by the MCP SDK against
  // `input`) and the actor (the user the API token was issued to).
  // Returns an arbitrary JSON-serializable result.
  handler: (args: unknown, ctx: ActorContext) => Promise<unknown>;
}

// Author-time helper. Takes a shape-aware definition and erases the
// handler's args type for storage in the global tool list.
function tool<S extends ZodRawShape>(def: {
  name: string;
  description: string;
  scope: ApiTokenScope;
  destructive?: boolean;
  input: S;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ActorContext) => Promise<unknown>;
}): McpToolDef {
  return {
    name: def.name,
    description: def.description,
    scope: def.scope,
    destructive: def.destructive,
    input: def.input,
    handler: (args, ctx) =>
      def.handler(args as z.objectOutputType<S, z.ZodTypeAny>, ctx),
  };
}

// ─── Read tools ─────────────────────────────────────────────────────────────

const listDealsTool = tool({
  name: 'pipeline_list_deals',
  description:
    'List deals in the pipeline. Filter by stage, owner, or free-text title query. Returns the most recently updated deals first.',
  scope: 'read',
  input: {
    q: z.string().max(200).optional().describe('Free-text title search (case-insensitive substring).'),
    stageId: z.number().int().positive().optional().describe('Restrict to a single stage by id.'),
    ownerId: z.number().int().positive().optional().describe('Restrict to a single owner (user id).'),
    limit: z.number().int().min(1).max(200).optional().describe('Max rows to return (default 50, cap 200).'),
  },
  handler: async (args) => svc.listDeals(args),
});

const getDealTool = tool({
  name: 'pipeline_get_deal',
  description:
    'Get a single deal by id, with embedded notes, tasks, attachments, recent activity, custom fields, and tags.',
  scope: 'read',
  input: {
    id: z.number().int().positive(),
  },
  handler: async ({ id }) => svc.getDeal(id),
});

const listCompaniesTool = tool({
  name: 'pipeline_list_companies',
  description: 'List companies. Filter by free-text name query.',
  scope: 'read',
  input: {
    q: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  handler: async (args) => svc.listCompanies(args),
});

const getCompanyTool = tool({
  name: 'pipeline_get_company',
  description: 'Get a single company by id.',
  scope: 'read',
  input: { id: z.number().int().positive() },
  handler: async ({ id }) => svc.getCompany(id),
});

const listContactsTool = tool({
  name: 'pipeline_list_contacts',
  description:
    'List contacts. Filter by company id and/or free-text query (matches first name, last name, email).',
  scope: 'read',
  input: {
    q: z.string().max(200).optional(),
    companyId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  handler: async (args) => svc.listContacts(args),
});

const getContactTool = tool({
  name: 'pipeline_get_contact',
  description: 'Get a single contact by id, with their company.',
  scope: 'read',
  input: { id: z.number().int().positive() },
  handler: async ({ id }) => svc.getContact(id),
});

const listTasksTool = tool({
  name: 'pipeline_list_tasks',
  description:
    'List tasks. Filter by status (pending/completed), deal id, or assignee. Sorts pending-first then by due date.',
  scope: 'read',
  input: {
    status: z.enum(['pending', 'completed']).optional(),
    dealId: z.number().int().positive().optional(),
    assignedTo: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  handler: async (args) => svc.listTasks(args),
});

const listStagesTool = tool({
  name: 'pipeline_list_stages',
  description:
    'List the configured pipeline stages in display order. Use this to discover stage ids before creating or moving deals.',
  scope: 'read',
  input: {},
  handler: async () => svc.listStages(),
});

const listTagsTool = tool({
  name: 'pipeline_list_tags',
  description: 'List all tags. Tags can attach to deals, companies, or contacts.',
  scope: 'read',
  input: {},
  handler: async () => svc.listTags(),
});

const searchTool = tool({
  name: 'pipeline_search',
  description:
    'Cross-entity search across deals (by title), companies (by name), and contacts (by name/email). Use when you have a string and don\'t yet know what type of record it refers to.',
  scope: 'read',
  input: {
    q: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(200).optional(),
  },
  handler: async ({ q, limit }) => svc.searchAll({ q, limit }),
});

// ─── Write tools ────────────────────────────────────────────────────────────

const createDealTool = tool({
  name: 'pipeline_create_deal',
  description:
    'Create a new deal. Must reference an existing pipeline stage id (call pipeline_list_stages to discover them). Optional company, primary contact, owner, tags, and custom fields.',
  scope: 'write',
  input: {
    title: z.string().min(1).max(200),
    amount: z.number().nonnegative().optional(),
    currency: z.string().min(3).max(8).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    expectedCloseDate: z.string().nullable().optional()
      .describe('YYYY-MM-DD; null clears.'),
    stageId: z.number().int().positive(),
    companyId: z.number().int().positive().nullable().optional(),
    primaryContactId: z.number().int().positive().nullable().optional(),
    tagIds: z.array(z.number().int().positive()).optional(),
    customFields: z.record(z.union([
      z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
    ])).optional(),
  },
  handler: async (args, ctx) => svc.createDeal(args, ctx),
});

const updateDealTool = tool({
  name: 'pipeline_update_deal',
  description:
    'Update fields on an existing deal. Pass only the fields you want to change. Changing stageId records a stage-change activity and re-orders the board.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    title: z.string().min(1).max(200).optional(),
    amount: z.number().nonnegative().optional(),
    currency: z.string().min(3).max(8).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    expectedCloseDate: z.string().nullable().optional(),
    stageId: z.number().int().positive().optional(),
    companyId: z.number().int().positive().nullable().optional(),
    primaryContactId: z.number().int().positive().nullable().optional(),
    tagIds: z.array(z.number().int().positive()).optional(),
    customFields: z.record(z.union([
      z.string(), z.number(), z.boolean(), z.array(z.string()), z.null(),
    ])).optional(),
  },
  handler: async ({ id, ...rest }, ctx) => svc.updateDeal(id, rest, ctx),
});

const moveDealTool = tool({
  name: 'pipeline_move_deal',
  description:
    'Move a deal to a different pipeline stage and/or position within a stage. position is the 0-indexed slot in the destination stage\'s board ordering.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    stageId: z.number().int().positive(),
    position: z.number().int().min(0),
  },
  handler: async ({ id, stageId, position }, ctx) =>
    svc.moveDeal(id, { stageId, position }, ctx),
});

const createCompanyTool = tool({
  name: 'pipeline_create_company',
  description:
    'Create a new company. Name is matched case-insensitively against existing companies — if one already exists with that name the API returns a 409.',
  scope: 'write',
  input: {
    name: z.string().min(1).max(200),
    industry: z.string().max(120).nullable().optional(),
    website: z.string().max(255).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
  },
  handler: async (args) => svc.createCompany(args),
});

const updateCompanyTool = tool({
  name: 'pipeline_update_company',
  description: 'Update fields on an existing company.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    industry: z.string().max(120).nullable().optional(),
    website: z.string().max(255).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
  },
  handler: async ({ id, ...rest }) => svc.updateCompany(id, rest),
});

const createContactTool = tool({
  name: 'pipeline_create_contact',
  description: 'Create a new contact. Optionally attach to a company by id.',
  scope: 'write',
  input: {
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    email: z.string().max(255).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    title: z.string().max(120).nullable().optional(),
    companyId: z.number().int().positive().nullable().optional(),
  },
  handler: async (args) => svc.createContact(args),
});

const updateContactTool = tool({
  name: 'pipeline_update_contact',
  description: 'Update fields on an existing contact.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    email: z.string().max(255).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    title: z.string().max(120).nullable().optional(),
    companyId: z.number().int().positive().nullable().optional(),
  },
  handler: async ({ id, ...rest }) => svc.updateContact(id, rest),
});

const createTaskTool = tool({
  name: 'pipeline_create_task',
  description: 'Create a task. Optionally attach to a deal by id.',
  scope: 'write',
  input: {
    title: z.string().min(1).max(255),
    description: z.string().max(10_000).nullable().optional(),
    dueDate: z.string().nullable().optional()
      .describe('ISO date (YYYY-MM-DD).'),
    dealId: z.number().int().positive().nullable().optional(),
    assignedTo: z.number().int().positive().nullable().optional(),
  },
  handler: async (args, ctx) => svc.createTask(args, ctx),
});

const updateTaskTool = tool({
  name: 'pipeline_update_task',
  description:
    'Update fields on an existing task. Setting status to "completed" stamps completedAt and logs a task_completed activity on the parent deal.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(10_000).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    status: z.enum(['pending', 'completed']).optional(),
    dealId: z.number().int().positive().nullable().optional(),
    assignedTo: z.number().int().positive().nullable().optional(),
  },
  handler: async ({ id, ...rest }, ctx) => svc.updateTask(id, rest, ctx),
});

const createNoteTool = tool({
  name: 'pipeline_create_note',
  description: 'Add a note to a deal. Notes are surfaced in the deal\'s activity log.',
  scope: 'write',
  input: {
    dealId: z.number().int().positive(),
    content: z.string().min(1).max(10_000),
  },
  handler: async (args, ctx) => svc.createNote(args, ctx),
});

const updateNoteTool = tool({
  name: 'pipeline_update_note',
  description: 'Edit an existing note\'s content.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    content: z.string().min(1).max(10_000),
  },
  handler: async ({ id, content }) => svc.updateNote(id, { content }),
});

const createTagTool = tool({
  name: 'pipeline_create_tag',
  description: 'Create a new tag. Tags are polymorphic — attach to deals, companies, or contacts via update tools.',
  scope: 'write',
  input: {
    name: z.string().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  },
  handler: async (args) => svc.createTag(args),
});

const updateTagTool = tool({
  name: 'pipeline_update_tag',
  description: 'Rename or recolor an existing tag.',
  scope: 'write',
  input: {
    id: z.number().int().positive(),
    name: z.string().min(1).max(40).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  },
  handler: async ({ id, ...rest }) => svc.updateTag(id, rest),
});

// ─── Destructive tools (require approval) ───────────────────────────────────

const deleteDealTool = tool({
  name: 'pipeline_delete_deal',
  description:
    'Permanently delete a deal, along with its notes, tasks, attachments, custom-field values, and tag attachments. Irreversible — first call returns an approval token; the second call must pass it back as `confirmationToken`.',
  scope: 'delete',
  destructive: true,
  input: {
    id: z.number().int().positive(),
    confirmationToken: z.string().optional()
      .describe('Approval token returned by the first call. Required to actually delete.'),
  },
  handler: async ({ id }) => svc.deleteDeal(id),
});

const deleteCompanyTool = tool({
  name: 'pipeline_delete_company',
  description:
    'Permanently delete a company. Contacts attached to it have their companyId nulled (the contacts themselves are kept). Irreversible — requires confirmationToken.',
  scope: 'delete',
  destructive: true,
  input: {
    id: z.number().int().positive(),
    confirmationToken: z.string().optional(),
  },
  handler: async ({ id }) => svc.deleteCompany(id),
});

const deleteContactTool = tool({
  name: 'pipeline_delete_contact',
  description: 'Permanently delete a contact. Irreversible — requires confirmationToken.',
  scope: 'delete',
  destructive: true,
  input: {
    id: z.number().int().positive(),
    confirmationToken: z.string().optional(),
  },
  handler: async ({ id }) => svc.deleteContact(id),
});

const deleteTaskTool = tool({
  name: 'pipeline_delete_task',
  description: 'Permanently delete a task. Irreversible — requires confirmationToken.',
  scope: 'delete',
  destructive: true,
  input: {
    id: z.number().int().positive(),
    confirmationToken: z.string().optional(),
  },
  handler: async ({ id }) => svc.deleteTask(id),
});

const deleteNoteTool = tool({
  name: 'pipeline_delete_note',
  description: 'Permanently delete a note. Irreversible — requires confirmationToken.',
  scope: 'delete',
  destructive: true,
  input: {
    id: z.number().int().positive(),
    confirmationToken: z.string().optional(),
  },
  handler: async ({ id }) => svc.deleteNote(id),
});

const deleteTagTool = tool({
  name: 'pipeline_delete_tag',
  description:
    'Permanently delete a tag, removing it from every deal, company, and contact it was attached to. Irreversible — requires confirmationToken.',
  scope: 'delete',
  destructive: true,
  input: {
    id: z.number().int().positive(),
    confirmationToken: z.string().optional(),
  },
  handler: async ({ id }) => svc.deleteTag(id),
});

export const ALL_TOOLS: McpToolDef[] = [
  // read
  listDealsTool,
  getDealTool,
  listCompaniesTool,
  getCompanyTool,
  listContactsTool,
  getContactTool,
  listTasksTool,
  listStagesTool,
  listTagsTool,
  searchTool,
  // write
  createDealTool,
  updateDealTool,
  moveDealTool,
  createCompanyTool,
  updateCompanyTool,
  createContactTool,
  updateContactTool,
  createTaskTool,
  updateTaskTool,
  createNoteTool,
  updateNoteTool,
  createTagTool,
  updateTagTool,
  // delete (destructive — approval-gated)
  deleteDealTool,
  deleteCompanyTool,
  deleteContactTool,
  deleteTaskTool,
  deleteNoteTool,
  deleteTagTool,
];
