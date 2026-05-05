// Request-surface tests for /api/enrichment. Like the webhooks/api-tokens
// suites, these cover auth/origin/CSRF and validation gating only — the
// CRUD + LLM round-trip belongs in a future end-to-end suite.

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

describe('/api/enrichment', () => {
  const app = buildApp();

  it('returns 401 on GET /settings without a session cookie', async () => {
    const res = await request(app).get('/api/enrichment/settings');
    expect(res.status).toBe(401);
  });

  it('returns 401 on PATCH /settings without auth', async () => {
    const res = await request(app)
      .patch('/api/enrichment/settings')
      .set('Origin', 'http://localhost:5173')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('rejects PATCH /settings without origin (CSRF guard fires before auth)', async () => {
    const res = await request(app)
      .patch('/api/enrichment/settings')
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('returns 401 on POST /ping without auth', async () => {
    const res = await request(app)
      .post('/api/enrichment/ping')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST /companies/:id without auth', async () => {
    const res = await request(app)
      .post('/api/enrichment/companies/42')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /runs/:id without auth', async () => {
    const res = await request(app).get('/api/enrichment/runs/abc');
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST /runs/:id/apply without auth', async () => {
    const res = await request(app)
      .post('/api/enrichment/runs/abc/apply')
      .set('Origin', 'http://localhost:5173')
      .send({ runId: 'abc', fields: [], applySummary: true });
    expect(res.status).toBe(401);
  });

  it('rejects POST /runs/:id/apply without origin (CSRF guard fires first)', async () => {
    const res = await request(app)
      .post('/api/enrichment/runs/abc/apply')
      .send({ runId: 'abc', fields: [], applySummary: true });
    expect(res.status).toBe(403);
  });
});
