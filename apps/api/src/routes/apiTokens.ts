import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { apiTokenCreateSchema, type ApiTokenDto, type ApiTokenScope } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { requireUserSession } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import {
  formatToken,
  hashTokenSecret,
  newTokenId,
  newTokenSecret,
  tokenScopes,
} from '../auth/apiToken.js';
import { rateLimit } from '../lib/rateLimit.js';

export const apiTokensRouter = Router();
// Token issuance and revocation must be tied to an interactive session —
// an agent shouldn't be able to mint more tokens with its own.
apiTokensRouter.use(requireUserSession);

// Cap how often a single user can create tokens — defense against a
// compromised session minting hundreds of tokens before the user notices.
const tokenWriteLimiter = rateLimit({
  max: 20,
  message: 'Too many token changes, slow down',
});

type ApiTokenRow = {
  id: string;
  name: string;
  scopes: Prisma.JsonValue;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

function tokenDto(t: ApiTokenRow, options: { token?: string } = {}): ApiTokenDto {
  const scopes = Array.isArray(t.scopes)
    ? (t.scopes as unknown[]).filter(
        (s): s is ApiTokenScope => typeof s === 'string',
      )
    : [];
  const dto: ApiTokenDto = {
    id: t.id,
    name: t.name,
    scopes: scopes as ApiTokenScope[],
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
  if (options.token) dto.token = options.token;
  return dto;
}

apiTokensRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // Tokens belong to the issuing user. Single-tenant app, but each
    // user still only sees their own tokens — they're personal credentials.
    const tokens = await prisma.apiToken.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ tokens: tokens.map((t) => tokenDto(t)) });
  }),
);

apiTokensRouter.post(
  '/',
  tokenWriteLimiter,
  asyncHandler(async (req, res) => {
    const input = apiTokenCreateSchema.parse(req.body);
    const id = newTokenId();
    const secret = newTokenSecret();
    const secretHash = await hashTokenSecret(secret);
    const created = await prisma.apiToken.create({
      data: {
        id,
        userId: req.user!.id,
        name: input.name,
        secretHash,
        scopes: input.scopes as unknown as Prisma.InputJsonValue,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    const wire = formatToken(id, secret);
    res.status(201).json({ token: tokenDto(created, { token: wire }) });
  }),
);

apiTokensRouter.delete(
  '/:id',
  tokenWriteLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!id) throw new HttpError(400, 'Missing token id');
    const existing = await prisma.apiToken.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.user!.id) {
      // Never leak existence of someone else's token.
      throw new HttpError(404, 'Token not found');
    }
    if (existing.revokedAt) {
      // Idempotent — already revoked, return current state.
      res.json({ token: tokenDto(existing) });
      return;
    }
    const updated = await prisma.apiToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    res.json({ token: tokenDto(updated) });
  }),
);

// Surfaces the scope catalog so the UI doesn't have to hardcode it.
apiTokensRouter.get(
  '/scopes',
  asyncHandler(async (_req, res) => {
    res.json({
      scopes: [
        {
          name: 'read',
          label: 'Read',
          description:
            'List and view deals, contacts, companies, tasks, notes, tags, stages.',
        },
        {
          name: 'write',
          label: 'Write',
          description:
            'Create and update deals, contacts, companies, tasks, notes, tags. Move deals between stages.',
        },
        {
          name: 'delete',
          label: 'Delete',
          description:
            'Delete deals, contacts, companies, tasks, notes. Destructive — every delete still issues a per-call approval prompt before it runs.',
        },
      ],
    });
  }),
);

// Re-export so other modules (MCP layer) can introspect a token's scopes
// without re-importing the helper from auth/.
export { tokenScopes };
