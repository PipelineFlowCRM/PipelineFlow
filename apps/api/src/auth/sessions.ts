import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../db.js';
import { env } from '../env.js';

const COOKIE_NAME = 'pf_session';
const SESSION_TTL_DAYS = 30;

const ttlMs = () => SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const newToken = () => randomBytes(32).toString('base64url');

export async function createSession(
  req: Request,
  res: Response,
  userId: number,
): Promise<string> {
  const id = newToken();
  const expiresAt = new Date(Date.now() + ttlMs());
  await prisma.session.create({
    data: {
      id,
      userId,
      expiresAt,
      userAgent: req.get('user-agent') ?? null,
      ipAddress: req.ip ?? null,
    },
  });
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
  return id;
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const id = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (id) {
    await prisma.session.deleteMany({ where: { id } }).catch(() => undefined);
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export async function destroySessionById(userId: number, sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId, userId } });
}

export async function destroyAllOtherSessions(
  userId: number,
  keepId: string,
): Promise<number> {
  const out = await prisma.session.deleteMany({
    where: { userId, NOT: { id: keepId } },
  });
  return out.count;
}

export async function loadSession(token: string) {
  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { id: token },
    include: { user: true },
  });
  if (!session || session.expiresAt < now) return null;
  // Touch lastSeenAt at most once per minute to avoid write storms.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session
      .update({ where: { id: token }, data: { lastSeenAt: now } })
      .catch(() => undefined);
  }
  return session;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
