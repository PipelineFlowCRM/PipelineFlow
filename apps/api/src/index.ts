import { buildApp } from './server.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { prisma } from './db.js';
import { closeQueues } from './lib/queue.js';

const app = buildApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'PipelineFlow API listening');
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // Order: stop accepting requests → drain in-flight → close queue producer
  // and Redis → disconnect Prisma. Closing the BullMQ Queue after the HTTP
  // server quiesces means no handler is mid-enqueue when the connection
  // goes away.
  server.close(async (err) => {
    if (err) logger.error({ err }, 'error during server.close');
    try {
      await closeQueues();
    } catch (e) {
      logger.error({ err: e }, 'error closing queues');
    }
    try {
      await prisma.$disconnect();
    } catch (e) {
      logger.error({ err: e }, 'error disconnecting prisma');
    }
    process.exit(err ? 1 : 0);
  });
  // Bumped from 10s to 15s — Redis quit + queue close add latency on top
  // of HTTP drain.
  setTimeout(() => {
    logger.warn('forced exit after 15s grace');
    process.exit(1);
  }, 15_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
