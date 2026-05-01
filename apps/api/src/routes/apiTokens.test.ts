import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

// Like the webhooks suite, these tests cover the request-validation surface
// only — auth gating, origin guard, payload schema. CRUD round-trips that
// hit Postgres belong in a future end-to-end suite.

describe('/api/api-tokens', () => {
  const app = buildApp();

  it('returns 401 on GET without a session cookie', async () => {
    const res = await request(app).get('/api/api-tokens');
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST without auth', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Claude', scopes: ['read'] });
    expect(res.status).toBe(401);
  });

  it('rejects POST without origin (CSRF guard fires before auth)', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .send({ name: 'x', scopes: ['read'] });
    expect(res.status).toBe(403);
  });

  it('returns 401 on DELETE without auth', async () => {
    const res = await request(app)
      .delete('/api/api-tokens/tok_abc')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('keeps the scope catalog session-gated', async () => {
    // Session-only because scopes catalog is a settings-page surface.
    // Anonymous callers don't need to discover it; the MCP layer
    // enforces scope semantics on its own.
    const res = await request(app).get('/api/api-tokens/scopes');
    expect(res.status).toBe(401);
  });
});
