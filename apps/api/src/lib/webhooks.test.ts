import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  assertWebhookUrlAllowed,
  buildSignatureHeader,
  generateEventId,
  generateWebhookSecret,
  isPrivateHost,
  shouldRetryStatus,
  truncateResponseBody,
  verifySignature,
  RESPONSE_BODY_MAX_BYTES,
} from './webhooks.js';

describe('generateWebhookSecret', () => {
  it('returns a whsec_-prefixed token with sufficient entropy', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
});

describe('generateEventId', () => {
  it('returns an evt_-prefixed id', () => {
    expect(generateEventId()).toMatch(/^evt_[A-Za-z0-9_-]{10,}$/);
  });
});

describe('buildSignatureHeader', () => {
  it('produces a t=,v1= header where v1 is HMAC-SHA256 of `<t>.<body>`', () => {
    const secret = 'whsec_test';
    const body = '{"hello":"world"}';
    const t = 1700000000;
    const header = buildSignatureHeader(secret, body, t);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(header.endsWith(expected)).toBe(true);
  });

  it('changes when the body changes', () => {
    const a = buildSignatureHeader('s', '{"a":1}', 1);
    const b = buildSignatureHeader('s', '{"a":2}', 1);
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = buildSignatureHeader('s1', 'body', 1);
    const b = buildSignatureHeader('s2', 'body', 1);
    expect(a).not.toBe(b);
  });
});

describe('verifySignature', () => {
  it('verifies a freshly built signature within tolerance', () => {
    const secret = 'whsec_x';
    const body = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    const header = buildSignatureHeader(secret, body, t);
    expect(verifySignature(secret, body, header)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const secret = 'whsec_x';
    const t = Math.floor(Date.now() / 1000);
    const header = buildSignatureHeader(secret, '{"a":1}', t);
    expect(verifySignature(secret, '{"a":2}', header)).toBe(false);
  });

  it('rejects a stale timestamp outside tolerance', () => {
    const secret = 'whsec_x';
    const t = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const header = buildSignatureHeader(secret, 'body', t);
    expect(verifySignature(secret, 'body', header, 300)).toBe(false);
  });

  it('rejects garbage headers without throwing', () => {
    expect(verifySignature('s', 'b', '')).toBe(false);
    expect(verifySignature('s', 'b', 'not-a-real-header')).toBe(false);
    expect(verifySignature('s', 'b', 't=abc,v1=xyz')).toBe(false);
  });
});

describe('truncateResponseBody', () => {
  it('passes through bodies under the cap', () => {
    expect(truncateResponseBody('hi')).toBe('hi');
  });

  it('truncates to <= cap and appends an ellipsis', () => {
    const big = 'a'.repeat(RESPONSE_BODY_MAX_BYTES + 100);
    const out = truncateResponseBody(big);
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_MAX_BYTES + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('isPrivateHost', () => {
  it('flags loopback and docker dev names', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('host.docker.internal')).toBe(true);
    expect(isPrivateHost('gateway.docker.internal')).toBe(true);
    expect(isPrivateHost('foo.local')).toBe(true);
    expect(isPrivateHost('bar.internal')).toBe(true);
    expect(isPrivateHost('home.arpa')).toBe(false); // exact match excluded; suffix only
    expect(isPrivateHost('example.home.arpa')).toBe(true);
  });

  it('flags bare service names without dots', () => {
    expect(isPrivateHost('postgres')).toBe(true);
    expect(isPrivateHost('redis')).toBe(true);
    expect(isPrivateHost('worker')).toBe(true);
  });

  it('flags RFC 1918 / loopback / link-local IPv4', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('10.0.0.5')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.254')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true); // AWS / Azure metadata
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('239.0.0.1')).toBe(true); // multicast
  });

  it('does NOT flag public IPv4', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false); // 172.32 is outside 1918
    expect(isPrivateHost('172.15.255.255')).toBe(false); // 172.15 is outside 1918
  });

  it('flags IPv6 loopback / link-local / ULA', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('::')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fdff::1')).toBe(true);
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true); // v4-mapped loopback
  });

  it('does not flag public domain names', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('webhook.example.org')).toBe(false);
    expect(isPrivateHost('hooks.zapier.com')).toBe(false);
  });
});

describe('assertWebhookUrlAllowed', () => {
  it('returns the parsed URL when target is public', () => {
    const url = assertWebhookUrlAllowed('https://hooks.example.com/x', false);
    expect(url.hostname).toBe('hooks.example.com');
  });

  it('throws on private target when flag is off', () => {
    expect(() => assertWebhookUrlAllowed('http://localhost:8000', false)).toThrow(/private/);
    expect(() => assertWebhookUrlAllowed('http://192.168.1.1', false)).toThrow(/private/);
  });

  it('allows private target when flag is on', () => {
    expect(() => assertWebhookUrlAllowed('http://localhost:8000', true)).not.toThrow();
    expect(() => assertWebhookUrlAllowed('http://host.docker.internal:8000', true)).not.toThrow();
  });

  it('throws on unparseable URL regardless of flag', () => {
    expect(() => assertWebhookUrlAllowed('not a url', true)).toThrow();
  });
});

describe('shouldRetryStatus', () => {
  it('retries 5xx', () => {
    expect(shouldRetryStatus(500)).toBe(true);
    expect(shouldRetryStatus(503)).toBe(true);
    expect(shouldRetryStatus(599)).toBe(true);
  });

  it('retries 408 and 429', () => {
    expect(shouldRetryStatus(408)).toBe(true);
    expect(shouldRetryStatus(429)).toBe(true);
  });

  it('does not retry common 4xx', () => {
    expect(shouldRetryStatus(400)).toBe(false);
    expect(shouldRetryStatus(401)).toBe(false);
    expect(shouldRetryStatus(403)).toBe(false);
    expect(shouldRetryStatus(404)).toBe(false);
    expect(shouldRetryStatus(410)).toBe(false);
    expect(shouldRetryStatus(422)).toBe(false);
  });

  it('does not retry 2xx/3xx (caller should not be asking, but defensive)', () => {
    expect(shouldRetryStatus(200)).toBe(false);
    expect(shouldRetryStatus(301)).toBe(false);
  });
});
