import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

// Validation-surface only: auth gating, origin guard, payload schema. Same
// scope as webhooks.test.ts — anything past the route validators (S3 round-
// trips, Prisma writes) belongs in a future end-to-end suite that boots
// a test DB and S3 stub. The key gate to verify here is that every
// /api/import/* endpoint refuses unauthenticated requests, since the
// table holds raw CSV uploads tied to a user.

describe('/api/import/*', () => {
  const app = buildApp();

  it('returns 401 on POST /upload without auth', async () => {
    const res = await request(app)
      .post('/api/import/upload')
      .set('Origin', 'http://localhost:5173')
      .attach('file', Buffer.from('a,b\n1,2'), 'test.csv')
      .field('entityType', 'company');
    expect(res.status).toBe(401);
  });

  it('rejects mutating requests without an Origin header', async () => {
    const res = await request(app)
      .post('/api/import/upload')
      .attach('file', Buffer.from('a,b\n1,2'), 'test.csv')
      .field('entityType', 'company');
    expect(res.status).toBe(403);
  });

  it('returns 401 on POST /:id/dry-run without auth', async () => {
    const res = await request(app)
      .post('/api/import/abc123/dry-run')
      .set('Origin', 'http://localhost:5173')
      .send({ entityType: 'company', mapping: {} });
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST /:id/commit without auth', async () => {
    const res = await request(app)
      .post('/api/import/abc123/commit')
      .set('Origin', 'http://localhost:5173')
      .send({ entityType: 'company', mapping: {} });
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /jobs without auth', async () => {
    const res = await request(app).get('/api/import/jobs');
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /jobs/:id without auth', async () => {
    const res = await request(app).get('/api/import/jobs/abc123');
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /jobs/:id/errors.csv without auth', async () => {
    const res = await request(app).get('/api/import/jobs/abc123/errors.csv');
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /presets without auth', async () => {
    const res = await request(app).get('/api/import/presets');
    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE /jobs/:id without auth', async () => {
    const res = await request(app)
      .delete('/api/import/jobs/abc123')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('rejects DELETE /jobs/:id without an Origin header', async () => {
    const res = await request(app).delete('/api/import/jobs/abc123');
    expect(res.status).toBe(403);
  });
});
