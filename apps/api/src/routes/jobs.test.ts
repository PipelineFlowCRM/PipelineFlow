import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

// vitest.config.ts sets JOBS_TEST_ENDPOINT_ENABLED=true so the route is
// mounted. These tests only exercise paths that don't actually hit Redis
// (auth + validation), so the dangling ioredis connection from queue.ts is
// harmless test-time noise.

describe('/api/jobs/generate', () => {
  const app = buildApp();

  it('returns 401 when called without an auth cookie', async () => {
    const res = await request(app)
      .post('/api/jobs/generate')
      .set('Origin', 'http://localhost:5173')
      .send({ sleepMs: 100 });
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET status without auth', async () => {
    const res = await request(app).get('/api/jobs/generate/abc-123');
    expect(res.status).toBe(401);
  });

  it('rejects mutating requests without an Origin header (originGuard)', async () => {
    // No Origin/Referer → originGuard returns 403 before requireAuth runs.
    const res = await request(app).post('/api/jobs/generate').send({ sleepMs: 100 });
    expect(res.status).toBe(403);
  });
});
