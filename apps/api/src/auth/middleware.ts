import type { Request, RequestHandler } from 'express';
import type { ApiToken, User } from '@prisma/client';
import { HttpError } from '../lib/error.js';
import { env } from '../env.js';
import { SESSION_COOKIE_NAME, loadSession } from './sessions.js';
import { authenticateApiToken, touchLastUsed } from './apiToken.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
      // Set when the request was authenticated with an API bearer token
      // rather than a session cookie. Routes that should remain
      // user-only (e.g. issuing more tokens, password change) check
      // for `req.sessionId` instead of `req.user`.
      apiToken?: ApiToken;
    }
  }
}

/** Origin/Referer check — cheap CSRF defense for cookie-auth APIs. */
export const originGuard: RequestHandler = (req, _res, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();
  // Bearer-auth requests are not browser-cookie flows, so the CSRF
  // model doesn't apply. Skip the origin check for them; the bearer
  // token itself is the auth credential and unlike a cookie isn't
  // sent automatically by browsers.
  if (req.get('authorization')?.toLowerCase().startsWith('bearer ')) return next();
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

const bearerFrom = (req: Request): string | null => {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value || null;
};

export const attachUser: RequestHandler = async (req, _res, next) => {
  try {
    // 1) Prefer session cookie — that's the browser path.
    const cookieToken = cookieFrom(req);
    if (cookieToken) {
      const session = await loadSession(cookieToken);
      if (session) {
        req.user = session.user;
        req.sessionId = session.id;
        return next();
      }
    }
    // 2) Fall back to bearer token — that's the agent / API client path.
    //    A request never carries both: the cookie wins if present.
    const bearer = bearerFrom(req);
    if (bearer) {
      const token = await authenticateApiToken(bearer);
      if (token) {
        req.user = token.user;
        req.apiToken = token;
        // Lazy lastUsed update; failures are non-fatal.
        void touchLastUsed(token);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
};

// Used by routes that must remain interactive-user-only (issuing tokens,
// changing password, deleting account). API tokens explicitly cannot
// escalate into these.
export const requireUserSession: RequestHandler = (req, _res, next) => {
  if (!req.sessionId || !req.user) {
    return next(new HttpError(401, 'Session authentication required'));
  }
  next();
};
