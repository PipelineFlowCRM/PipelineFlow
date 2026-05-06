import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

// Surface-level tests for the archive/unarchive endpoints — auth gating and
// origin guard. CRUD round-trips that exercise idempotency, activity-log
// writes, and webhook fan-out belong in a future end-to-end suite that boots
// a test DB. Same convention as routes/webhooks.test.ts.

describe('/api/deals/:id/archive', () => {
  const app = buildApp();

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/deals/1/archive')
      .set('Origin', 'http://localhost:5173')
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects mutating requests without an Origin header', async () => {
    const res = await request(app).post('/api/deals/1/archive').send({});
    expect(res.status).toBe(403);
  });
});

describe('/api/deals/:id/unarchive', () => {
  const app = buildApp();

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/deals/1/unarchive')
      .set('Origin', 'http://localhost:5173')
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects mutating requests without an Origin header', async () => {
    const res = await request(app).post('/api/deals/1/unarchive').send({});
    expect(res.status).toBe(403);
  });
});

describe('/api/deals/board', () => {
  const app = buildApp();

  it('returns 401 without auth (the route filters archivedAt: null server-side)', async () => {
    const res = await request(app).get('/api/deals/board');
    expect(res.status).toBe(401);
  });
});
