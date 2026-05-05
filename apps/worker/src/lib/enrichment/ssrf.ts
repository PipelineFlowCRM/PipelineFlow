// Hostname-literal SSRF guard. Mirrors the api's `isPrivateHost` in
// apps/api/src/lib/webhooks.ts — duplicated rather than cross-imported
// because the api↔worker package boundary is intentional. Keep these in
// lockstep when adding new private-range checks.
//
// We deliberately match on the *literal* hostname rather than resolving to
// an IP first: a DNS-rebinding attacker would otherwise resolve to a
// public IP at validation time and serve a private one at fetch time. The
// literal check stops the obvious cases (`localhost`, RFC 1918, link-local,
// AWS metadata) and the env flag (`ENRICHMENT_ALLOW_PRIVATE_TARGETS`)
// covers the homelab case where private targets are intentional.

import { isIP } from 'node:net';

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;

  if (
    host === 'localhost' ||
    host === 'host.docker.internal' ||
    host === 'gateway.docker.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.intranet') ||
    host.endsWith('.home.arpa')
  )
    return true;

  const ipKind = isIP(host);
  if (ipKind === 0) {
    // Bare hostname (no dots, not an IP) — treat as internal. Catches
    // docker-compose service names like `postgres`, `redis`, `worker`.
    if (!host.includes('.')) return true;
    return false;
  }

  if (ipKind === 4) {
    const parts = host.split('.').map((n) => Number(n));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const mapped = host.match(/^::ffff:([\d.]+)$/);
  if (mapped && mapped[1]) return isPrivateHost(mapped[1]);
  return false;
}
