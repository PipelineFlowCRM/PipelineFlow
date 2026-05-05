import { describe, it, expect } from 'vitest';
import { isPrivateHost } from './ssrf.js';

describe('isPrivateHost', () => {
  it('blocks loopback IPv4', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.5.5.5')).toBe(true);
  });

  it('blocks RFC 1918 ranges', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('192.168.1.5')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    // Outside 172.16/12 — public.
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('172.15.255.255')).toBe(false);
  });

  it('blocks AWS / GCE metadata endpoint (link-local)', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('169.254.1.1')).toBe(true);
  });

  it('blocks 0.0.0.0/8 and multicast', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('224.0.0.1')).toBe(true);
  });

  it('blocks docker / dev / internal hostnames', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('host.docker.internal')).toBe(true);
    expect(isPrivateHost('foo.local')).toBe(true);
    expect(isPrivateHost('bar.internal')).toBe(true);
  });

  it('blocks bare service names with no dots', () => {
    expect(isPrivateHost('postgres')).toBe(true);
    expect(isPrivateHost('redis')).toBe(true);
    expect(isPrivateHost('worker')).toBe(true);
  });

  it('blocks IPv6 loopback and private ranges', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('::')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 private ranges', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows public IPs and public hostnames', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('anthropic.com')).toBe(false);
    expect(isPrivateHost('www.example.com')).toBe(false);
  });

  it('blocks empty / malformed input', () => {
    expect(isPrivateHost('')).toBe(true);
  });

  it('handles bracketed IPv6 literals', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
  });
});
