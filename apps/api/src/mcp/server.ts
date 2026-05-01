import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tokenScopes } from '../auth/apiToken.js';
import type { LoadedApiToken } from '../auth/apiToken.js';
import { ALL_TOOLS, type McpToolDef } from './tools.js';
import {
  consumeApproval,
  fingerprintArgs,
  issueApproval,
  maybePurgeApprovals,
} from './approval.js';
import { recordAudit } from './audit.js';

// Strip the `confirmationToken` field so its presence/absence doesn't
// change the args fingerprint. Without this, an agent's pre-confirm
// call (no token) and its confirm call (with token) would fingerprint
// differently and the second call would always mismatch.
function fingerprintableArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k === 'confirmationToken') continue;
    out[k] = v;
  }
  return out;
}

// Trim the result for token-budget reasons. Agents don't need the entire
// activity log of a deal we just touched; the structured payload still
// has enough context for follow-up calls. The MCP client also gets the
// structured `structuredContent` block — we keep that complete for
// programmatic consumers.
const TEXT_RESULT_MAX_BYTES = 32_768;
function asTextBlock(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= TEXT_RESULT_MAX_BYTES) return text;
  return `${text.slice(0, TEXT_RESULT_MAX_BYTES)}\n\n…[truncated, ${text.length - TEXT_RESULT_MAX_BYTES} chars omitted; call with narrower filters or pagination]`;
}

// Builds an MCP server scoped to a *specific* authenticated API token.
// Each MCP request constructs a fresh server — that's the
// stateless-transport pattern, and it lets us register only the tools
// the caller's scopes cover (so a `read`-only token doesn't even see
// destructive tools in `tools/list`).
export function buildMcpServerForToken(token: LoadedApiToken): McpServer {
  const grantedScopes = new Set(tokenScopes(token));
  const server = new McpServer(
    {
      name: 'pipelineflow-mcp',
      version: '1.0.0',
    },
    {
      // Surface the authenticated user + scopes in the server's
      // initialization so the agent's UI can show "you're connected as
      // <name>". Optional but useful.
      instructions: [
        `You are connected to PipelineFlow as ${token.user.name} <${token.user.email}>.`,
        `Granted scopes: ${[...grantedScopes].join(', ') || '(none)'}.`,
        'Destructive tools (pipeline_delete_*) require a two-step confirmation: call once without confirmationToken to receive a token + summary, then call again echoing it back.',
      ].join(' '),
    },
  );

  for (const def of ALL_TOOLS) {
    if (!grantedScopes.has(def.scope)) continue;
    registerTool(server, def, token);
  }

  // Best-effort cleanup of expired approvals — runs at most every 5 min.
  void maybePurgeApprovals();

  return server;
}

function registerTool(
  server: McpServer,
  def: McpToolDef,
  token: LoadedApiToken,
): void {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.input,
      annotations: {
        title: def.name,
        readOnlyHint: def.scope === 'read',
        destructiveHint: !!def.destructive,
        // Idempotent unless we know otherwise; deals/contacts have
        // case-insensitive uniqueness so a second create with the same
        // payload returns the same row or 409s.
        idempotentHint: def.scope === 'read',
        // We talk to a closed CRM database — no external/open world.
        openWorldHint: false,
      },
    },
    async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      try {
        // Two-phase approval gating for destructive tools. Done here
        // (before the handler) so a bug in a service can't bypass it.
        if (def.destructive) {
          const confirmation = typeof args.confirmationToken === 'string'
            ? args.confirmationToken
            : undefined;
          const fpArgs = fingerprintableArgs(args);
          if (!confirmation) {
            const { id: approvalId, expiresAt } = await issueApproval({
              tokenId: token.id,
              toolName: def.name,
              args: fpArgs,
            });
            await recordAudit({
              tokenId: token.id,
              actorUserId: token.user.id,
              toolName: def.name,
              outcome: 'approval_required',
              args,
              summary: `Approval required for ${def.name}`,
              approvalId,
            });
            const payload = {
              status: 'approval_required',
              approvalToken: approvalId,
              expiresAt: expiresAt.toISOString(),
              tool: def.name,
              args: fpArgs,
              instructions:
                'This is a destructive, irreversible action. Show this to the user and get explicit confirmation. To proceed, call the same tool again with the same arguments plus `confirmationToken` set to the approvalToken above. The token expires in 5 minutes and is single-use.',
            };
            return {
              isError: false,
              content: [{ type: 'text', text: asTextBlock(payload) }],
              structuredContent: payload,
            };
          }
          // Confirmation provided — try to consume it.
          const result = await consumeApproval({
            approvalId: confirmation,
            tokenId: token.id,
            toolName: def.name,
            args: fpArgs,
          });
          if (!result.ok) {
            const reasonText = {
              not_found: 'unknown approval token',
              expired: 'approval token has expired (5 minute TTL)',
              consumed: 'approval token has already been used',
              mismatch: 'approval token does not match this tool/args',
            }[result.reason];
            await recordAudit({
              tokenId: token.id,
              actorUserId: token.user.id,
              toolName: def.name,
              outcome: 'error',
              args,
              errorMessage: `approval rejected: ${reasonText}`,
              approvalId: confirmation,
            });
            const payload = {
              status: 'approval_rejected',
              reason: result.reason,
              message: `Cannot proceed: ${reasonText}. Call the tool again without confirmationToken to obtain a fresh approval.`,
            };
            return {
              isError: true,
              content: [{ type: 'text', text: asTextBlock(payload) }],
              structuredContent: payload,
            };
          }
        }

        // Strip `confirmationToken` from the args we hand the handler
        // so service implementations don't have to ignore it.
        const handlerArgs: Record<string, unknown> = { ...args };
        delete handlerArgs.confirmationToken;
        const result = await def.handler(handlerArgs as never, { user: token.user });

        await recordAudit({
          tokenId: token.id,
          actorUserId: token.user.id,
          toolName: def.name,
          outcome: def.destructive ? 'approval_consumed' : 'success',
          args,
          summary: summarizeResult(def.name, result),
          approvalId: def.destructive
            ? (typeof args.confirmationToken === 'string' ? args.confirmationToken : undefined)
            : undefined,
        });

        return {
          isError: false,
          content: [{ type: 'text', text: asTextBlock(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'unknown error';
        await recordAudit({
          tokenId: token.id,
          actorUserId: token.user.id,
          toolName: def.name,
          outcome: 'error',
          args,
          errorMessage: message,
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${message}` }],
          structuredContent: { status: 'error', message },
        };
      }
    },
  );
}

// Best-effort one-line summary for the audit log. The full args + result
// stay in the structuredContent / args column; this is the human-readable
// breadcrumb you'd skim a list of audit rows by.
function summarizeResult(toolName: string, result: unknown): string {
  if (!result || typeof result !== 'object') return toolName;
  const r = result as Record<string, unknown>;
  if ('deal' in r && r.deal && typeof r.deal === 'object') {
    const d = r.deal as Record<string, unknown>;
    return `${toolName} → deal #${d.id} ${typeof d.title === 'string' ? d.title : ''}`.trim();
  }
  if ('company' in r && r.company && typeof r.company === 'object') {
    const c = r.company as Record<string, unknown>;
    return `${toolName} → company #${c.id} ${typeof c.name === 'string' ? c.name : ''}`.trim();
  }
  if ('contact' in r && r.contact && typeof r.contact === 'object') {
    const c = r.contact as Record<string, unknown>;
    return `${toolName} → contact #${c.id} ${typeof c.fullName === 'string' ? c.fullName : ''}`.trim();
  }
  if ('task' in r && r.task && typeof r.task === 'object') {
    const t = r.task as Record<string, unknown>;
    return `${toolName} → task #${t.id} ${typeof t.title === 'string' ? t.title : ''}`.trim();
  }
  if ('id' in r && 'deleted' in r) {
    return `${toolName} → deleted #${r.id}`;
  }
  if ('totalReturned' in r) {
    return `${toolName} → ${r.totalReturned} rows`;
  }
  return toolName;
}

// Reuse the fingerprint helper for tests
export { fingerprintArgs };
