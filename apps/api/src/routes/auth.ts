import { Router } from 'express';
import { loginSchema, registerSchema } from '@pipelineflow/shared';
import { prisma } from '../db.js';
import { hashPassword, isLegacyHash, verifyPassword } from '../auth/password.js';
import { createSession, destroySession } from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler, HttpError } from '../lib/error.js';
import { rateLimit } from '../lib/rateLimit.js';
import { env } from '../env.js';
import { userDto } from '../lib/serialize.js';

export const authRouter = Router();

// Per-IP throttle: covers both login + register so an attacker can't pivot
// to /register to keep slamming credentials past the login limit.
const authLimiter = rateLimit({
  max: env.RATE_LIMIT_LOGIN_MAX,
  message: 'Too many auth attempts, try again in a few minutes',
});

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existing) throw new HttpError(409, 'Email already registered');
    const user = await prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
      },
    });
    await createSession(req, res, user.id);
    res.status(201).json({ user: await userDto(user) });
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user) throw new HttpError(401, 'Invalid email or password');
    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) throw new HttpError(401, 'Invalid email or password');
    // Opportunistic upgrade: if this row still uses the imported Werkzeug
    // scrypt/pbkdf2 hash, replace it with argon2id on successful login.
    if (isLegacyHash(user.passwordHash)) {
      await prisma.user
        .update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.password) } })
        .catch(() => undefined);
    }
    await createSession(req, res, user.id);
    res.json({ user: await userDto(user) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await userDto(req.user!) });
  }),
);
