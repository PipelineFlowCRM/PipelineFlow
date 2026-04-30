import type { Request, RequestHandler } from 'express';
import type { User } from '@prisma/client';
import { HttpError } from '../lib/error.js';
import { env } from '../env.js';
import { SESSION_COOKIE_NAME, loadSession } from './sessions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

/** Origin/Referer check — cheap CSRF defense for cookie-auth APIs. */
export const originGuard: RequestHandler = (req, _res, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();
  const origin = req.get('origin') ?? req.get('referer');
  if (!origin) return next(new HttpError(403, 'Missing origin'));
  try {
    const u = new URL(origin);
    const allowed = new URL(env.APP_ORIGIN);
    if (u.origin === allowed.origin) return next();
  } catch {
    /* fall through */
  }
  next(new HttpError(403, 'Origin not allowed'));
};

const cookieFrom = (req: Request) =>
  (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];

export const attachUser: RequestHandler = async (req, _res, next) => {
  try {
    const token = cookieFrom(req);
    if (!token) return next();
    const session = await loadSession(token);
    if (!session) return next();
    req.user = session.user;
    req.sessionId = session.id;
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
};
