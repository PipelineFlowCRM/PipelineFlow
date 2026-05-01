import http from 'node:http';
import { env } from './env.js';
import { logger } from './logger.js';
import { redisConnection } from './queue.js';

// Tiny HTTP server so docker-compose can tell a wedged worker from a
// healthy one. The api uses /healthz for the same purpose; we mirror.
//
// Reports 503 when Redis isn't 'ready' so a worker that boots before the
// broker isn't considered healthy by the orchestrator.
export function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      const redisReady = redisConnection.status === 'ready';
      const body = JSON.stringify({
        status: redisReady ? 'ok' : 'degraded',
        redis: redisConnection.status,
      });
      res.writeHead(redisReady ? 200 : 503, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(env.WORKER_HEALTH_PORT, () => {
    logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health endpoint listening');
  });
  return server;
}
