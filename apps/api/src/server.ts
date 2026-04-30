import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './lib/error.js';
import { attachUser, originGuard } from './auth/middleware.js';
import { authRouter } from './routes/auth.js';
import { profileRouter } from './routes/profile.js';
import { stagesRouter } from './routes/stages.js';
import { tagsRouter } from './routes/tags.js';
import { companiesRouter } from './routes/companies.js';
import { contactsRouter } from './routes/contacts.js';
import { dealsRouter } from './routes/deals.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { uploadsRouter } from './routes/uploads.js';
import { searchRouter } from './routes/search.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportsRouter } from './routes/reports.js';

export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // CSP that's compatible with the Vite-built SPA: same-origin scripts/styles,
  // inline styles for shadcn/ui's dynamic class generation, S3 origins for
  // uploaded images, blob: for chart canvases. Tighten further once we drop
  // any remaining inline styles.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false, // S3 redirects don't always set CORP
    }),
  );

  app.use(
    cors({
      origin: env.APP_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  app.use(originGuard);
  app.use(attachUser);

  app.use('/api/auth', authRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/stages', stagesRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/deals', dealsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
