import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../server.js';

// Validation-only tests. CRUD round-trips that need a real ApiToken row
// belong in a future end-to-end suite that boots Postgres.
//
// All POSTs include `Authorization: Bearer pf_…` so the originGuard
// skip-on-bearer branch runs. Without that header, originGuard would
// 403 first — also a valid response, but it'd mask the auth error
// these tests are trying to assert.

describe('/api/mcp', () => {
  const app = buildApp();

  it('rejects POST without a bearer token (with Origin set)', async () => {
    // With Origin set, the originGuard passes. With no Authorization,
    // the route's own bearer check fires.
    const res = await request(app)
      .post('/api/mcp')
      .set('Origin', 'http://localhost:5173')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.body?.error?.message).toMatch(/bearer/i);
  });

  it('rejects POST without an Authorization header AND without an Origin', async () => {
    // No bearer → the originGuard's bearer-bypass doesn't fire → 403
    // because there's no Origin/Referer header. We want this to fail
    // closed rather than fall through to the bearer check.
    const res = await request(app)
      .post('/api/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(403);
  });

  it('rejects POST with a malformed bearer token', async () => {
    const res = await request(app)
      .post('/api/mcp')
      .set('Authorization', 'Bearer not-a-pf-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.body?.error?.message).toMatch(/invalid/i);
  });

  it('rejects GET — server runs in stateless mode', async () => {
    const res = await request(app).get('/api/mcp');
    expect(res.status).toBe(405);
  });

  it('rejects DELETE without origin (originGuard fires first)', async () => {
    // DELETE without an Origin header is blocked by the global CSRF
    // guard before reaching the route-level 405. That's by design — a
    // browser-cookie request without Origin is suspicious regardless of
    // method.
    const res = await request(app).delete('/api/mcp');
    expect(res.status).toBe(403);
  });

  it('rejects DELETE with a wrong origin', async () => {
    const res = await request(app)
      .delete('/api/mcp')
      .set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
  });

  it('returns 405 on DELETE from an allowed origin', async () => {
    const res = await request(app)
      .delete('/api/mcp')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(405);
  });
});
