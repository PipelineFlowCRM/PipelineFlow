import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public override message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};

const isProd = () => env.NODE_ENV === 'production';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.details !== undefined && !isProd() ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      fields: err.flatten().fieldErrors,
    });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res
        .status(409)
        .json({ error: 'Resource already exists', ...(isProd() ? {} : { meta: err.meta }) });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (err.code === 'P2003') {
      // Foreign-key constraint blocked the operation. Common case: deleting a
      // user with deals/notes/attachments still referencing them.
      res
        .status(409)
        .json({ error: 'Cannot complete: related records exist', ...(isProd() ? {} : { meta: err.meta }) });
      return;
    }
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
};

export const asyncHandler =
  (fn: (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
