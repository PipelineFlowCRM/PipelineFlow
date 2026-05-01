import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './lib/error.js';
import { attachUser, originGuard, requireAuth } from './auth/middleware.js';
import { allQueues, redisConnection } from './lib/queue.js';
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
import { customFieldsRouter } from './routes/customFields.js';
import { listPrefsRouter } from './routes/listPrefs.js';
import { jobsRouter } from './routes/jobs.js';
import { webhooksRouter } from './routes/webhooks.js';

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

  // Reflects Redis reachability so a half-broken pipeline (api up, Redis down)
  // doesn't show as healthy to the orchestrator. ioredis exposes a 'status'
  // string that is 'ready' once the handshake succeeds.
  app.get('/healthz', (_req, res) => {
    const redisReady = redisConnection.status === 'ready';
    if (!redisReady) {
      res.status(503).json({ status: 'degraded', redis: redisConnection.status });
      return;
    }
    res.json({ status: 'ok', redis: redisConnection.status });
  });

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
  app.use('/api/custom-fields', customFieldsRouter);
  app.use('/api/list-prefs', listPrefsRouter);
  app.use('/api/webhooks', webhooksRouter);
  // Smoke-test endpoint — disabled by default, opt in via JOBS_TEST_ENDPOINT_ENABLED.
  // Don't ship this surface in prod; future real job triggers will mount their
  // own routers (e.g. webhook ingest) at /api/jobs/<feature>.
  if (env.JOBS_TEST_ENDPOINT_ENABLED) {
    app.use('/api/jobs', jobsRouter);
  }

  if (env.BULL_BOARD_ENABLED) {
    // bull-board ships its own Express sub-app for the queue dashboard. Gate
    // it with requireAuth so only signed-in users can poke the queues.
    //
    // CSP override: bull-board pulls Ubuntu from fonts.googleapis.com and
    // emits inline scripts. Our global CSP is too strict for it. We layer a
    // looser CSP just on this mount — the second helmet middleware
    // overwrites the global Content-Security-Policy header for this route.
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: allQueues.map((q) => new BullMQAdapter(q)),
      serverAdapter,
    });
    app.use(
      '/admin/queues',
      requireAuth,
      helmet.contentSecurityPolicy({
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      }),
      serverAdapter.getRouter(),
    );
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
