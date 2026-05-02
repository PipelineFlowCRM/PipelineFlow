import { Router } from 'express';
import {
  changeEmailSchema,
  changePasswordSchema,
  updateProfileSchema,
} from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireAuth } from '../auth/middleware.js';
import {
  destroyAllOtherSessions,
  destroySession,
  destroySessionById,
} from '../auth/sessions.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { rateLimit } from '../lib/rateLimit.js';
import { env } from '../env.js';
import { obsoleteImageKey } from '../lib/s3.js';
import { enqueueS3Cleanup } from '../lib/queue.js';
import { userDto } from '../lib/serialize.js';

export const profileRouter = Router();

profileRouter.use(requireAuth);

const credentialLimiter = rateLimit({
  max: env.RATE_LIMIT_LOGIN_MAX,
  message: 'Too many credential changes, try again in a few minutes',
});

profileRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({ user: await userDto(req.user!) });
  }),
);

profileRouter.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    // Read the prior avatarUrl + write the update in one transaction so two
    // rapid replacements can't both see the same `req.user.avatarUrl` (set
    // by attachUser at request entry) and only enqueue cleanup for one of
    // them. `'avatarUrl' in input` keeps the no-op case (a name-only PATCH
    // that doesn't touch the avatar field) from deleting anything.
    const result = await prisma.$transaction(async (tx) => {
      const before =
        'avatarUrl' in input
          ? await tx.user.findUnique({
              where: { id: req.user!.id },
              select: { avatarUrl: true },
            })
          : null;
      const user = await tx.user.update({
        where: { id: req.user!.id },
        data: input,
      });
      return {
        user,
        obsolete: before
          ? obsoleteImageKey(before.avatarUrl, input.avatarUrl ?? null)
          : null,
      };
    });
    if (result.obsolete) {
      await enqueueS3Cleanup({ keys: [result.obsolete] });
    }
    res.json({ user: await userDto(result.user) });
  }),
);

profileRouter.post(
  '/change-password',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    const ok = await verifyPassword(req.user!.passwordHash, input.currentPassword);
    if (!ok) throw new HttpError(400, 'Current password is incorrect');
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { passwordHash: await hashPassword(input.newPassword) },
    });
    // Invalidate every other browser/device after a credential change.
    if (req.sessionId) {
      await destroyAllOtherSessions(req.user!.id, req.sessionId);
    }
    res.json({ ok: true });
  }),
);

profileRouter.post(
  '/change-email',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const input = changeEmailSchema.parse(req.body);
    const ok = await verifyPassword(req.user!.passwordHash, input.password);
    if (!ok) throw new HttpError(400, 'Password is incorrect');
    const taken = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (taken && taken.id !== req.user!.id)
      throw new HttpError(409, 'Email already in use');
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { email: input.email.toLowerCase() },
    });
    if (req.sessionId) {
      await destroyAllOtherSessions(req.user!.id, req.sessionId);
    }
    res.json({ user: await userDto(user) });
  }),
);

profileRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user!.id, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    // Don't expose the full session token (it's the auth cookie). The
    // last-8-chars label is enough for the user to recognize a session;
    // revoke endpoints accept the full id, which the client never needs to
    // see — the SessionsTab passes the id back through `id` here.
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        label: s.id.slice(-8),
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        current: s.id === req.sessionId,
      })),
    });
  }),
);

profileRouter.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!id) throw new HttpError(400, 'Missing session id');
    if (id === req.sessionId) {
      await destroySession(req, res);
      res.json({ ok: true, signedOut: true });
      return;
    }
    await destroySessionById(req.user!.id, id);
    res.json({ ok: true });
  }),
);

profileRouter.post(
  '/sessions/revoke-others',
  asyncHandler(async (req, res) => {
    const count = await destroyAllOtherSessions(req.user!.id, req.sessionId!);
    res.json({ ok: true, revoked: count });
  }),
);

profileRouter.delete(
  '/me',
  asyncHandler(async (req, res) => {
    // Migration `_user_delete_setnull` makes Deal.ownerId nullable + SET NULL
    // and weakens the same FK on Note/Attachment so this no longer trips
    // P2003 when the user has authored content.
    //
    // Re-read avatarUrl in the same transaction as the delete so a
    // concurrent PATCH /me changing the avatar can't orphan the new key.
    const avatarKey = await prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id: req.user!.id },
        select: { avatarUrl: true },
      });
      await tx.user.delete({ where: { id: req.user!.id } });
      return obsoleteImageKey(before?.avatarUrl ?? null, null);
    });
    if (avatarKey) {
      await enqueueS3Cleanup({ keys: [avatarKey] });
    }
    await destroySession(req, res);
    res.json({ ok: true });
  }),
);
