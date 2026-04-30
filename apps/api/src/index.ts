import { buildApp } from './server.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { prisma } from './db.js';

const app = buildApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'PipelineFlow API listening');
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  // Stop accepting new connections, then drain.
  server.close((err) => {
    if (err) logger.error({ err }, 'error during server.close');
    prisma.$disconnect().finally(() => process.exit(err ? 1 : 0));
  });
  // Hard-exit if we hang past 10s.
  setTimeout(() => {
    logger.warn('forced exit after 10s grace');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
