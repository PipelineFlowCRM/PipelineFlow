import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

// These tests only exercise the request-validation surface — auth gating,
// origin guard, payload schema. They don't touch Postgres or Redis, so a
// missing database in the test env doesn't matter. Anything past the
// validator (CRUD round-trips) belongs in a future end-to-end suite that
// boots a test DB.

describe('/api/webhooks/endpoints', () => {
  const app = buildApp();

  it('returns 401 on POST without an auth cookie', async () => {
    const res = await request(app)
      .post('/api/webhooks/endpoints')
      .set('Origin', 'http://localhost:5173')
      .send({
        name: 'Test',
        url: 'https://example.com/hook',
        events: ['deal.created'],
      });
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET without auth', async () => {
    const res = await request(app).get('/api/webhooks/endpoints');
    expect(res.status).toBe(401);
  });

  it('rejects mutating requests without an Origin header', async () => {
    // No Origin/Referer → originGuard returns 403 before requireAuth runs.
    const res = await request(app)
      .post('/api/webhooks/endpoints')
      .send({ name: 'x', url: 'https://example.com/h', events: ['deal.created'] });
    expect(res.status).toBe(403);
  });

  it('returns 401 on PATCH without auth', async () => {
    const res = await request(app)
      .patch('/api/webhooks/endpoints/1')
      .set('Origin', 'http://localhost:5173')
      .send({ enabled: false });
    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE without auth', async () => {
    const res = await request(app)
      .delete('/api/webhooks/endpoints/1')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('returns 401 on rotate-secret without auth', async () => {
    const res = await request(app)
      .post('/api/webhooks/endpoints/1/rotate-secret')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('returns 401 on test endpoint without auth', async () => {
    const res = await request(app)
      .post('/api/webhooks/endpoints/1/test')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });

  it('returns 401 on deliveries list without auth', async () => {
    const res = await request(app)
      .get('/api/webhooks/endpoints/1/deliveries');
    expect(res.status).toBe(401);
  });

  it('returns 401 on redeliver without auth', async () => {
    const res = await request(app)
      .post('/api/webhooks/deliveries/1/redeliver')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(401);
  });
});

describe('/api/webhooks/events catalog', () => {
  const app = buildApp();

  it('returns 401 without auth (the catalog still requires login since the whole router is gated)', async () => {
    const res = await request(app).get('/api/webhooks/events');
    expect(res.status).toBe(401);
  });
});
