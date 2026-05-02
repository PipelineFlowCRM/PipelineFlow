import { google, type people_v1 } from 'googleapis';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { GoogleAccount } from '@prisma/client';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';
import { logger } from '../../logger.js';

// People API client factory. Constructs an OAuth2Client primed with the
// account's refresh token, hooks the `tokens` event so a rotated refresh
// token (rare but does happen) is re-encrypted and persisted, and hands
// back a typed People client.
//
// The factory marks the account `disabledAt` if Google rejects the
// refresh token with `invalid_grant`. The pull / push processors check
// for that flag and skip the run rather than burning retries.

export type PeopleClient = people_v1.People;

const FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'urls',
  'biographies',
  'metadata',
].join(',');

// Allowlist of fields we'll write on update. Everything else (memberships,
// addresses, photos, birthdays, events, relations, userDefined) is
// preserved by virtue of being absent from updatePersonFields. Including
// any of those in the request would null the corresponding values out;
// google API treats the request body as authoritative for any field
// listed in updatePersonFields.
export const PERSON_UPDATE_PERSON_FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'urls',
  'biographies',
].join(',');

export const PERSON_READ_FIELDS = FIELDS;

export type PeopleClientHandle = {
  client: PeopleClient;
  oauth: OAuth2Client;
  account: GoogleAccount;
};

export async function loadGoogleAccount(googleAccountId: number): Promise<GoogleAccount | null> {
  return prisma.googleAccount.findUnique({ where: { id: googleAccountId } });
}

export class GoogleAccountDisabledError extends Error {
  constructor(public readonly reason: string, public readonly accountId: number) {
    super(`Google account ${accountId} disabled: ${reason}`);
  }
}

export async function buildPeopleClient(account: GoogleAccount): Promise<PeopleClientHandle> {
  if (account.disabledAt) {
    throw new GoogleAccountDisabledError(account.disabledReason ?? 'unknown', account.id);
  }
  const refreshToken = decryptSecret(
    account.encryptedRefreshToken,
    env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  );
  const oauth = new OAuth2Client({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
  oauth.setCredentials({ refresh_token: refreshToken });

  // Google rotates refresh tokens occasionally — when it does, the
  // `tokens` event fires with the new value. Re-encrypt and persist
  // synchronously so even a worker restart immediately afterwards
  // doesn't lose the new token.
  oauth.on('tokens', (tokens: Credentials) => {
    void (async () => {
      try {
        const updates: Record<string, unknown> = { lastRefreshedAt: new Date() };
        if (tokens.refresh_token) {
          updates.encryptedRefreshToken = encryptSecret(
            tokens.refresh_token,
            env.GOOGLE_TOKEN_ENCRYPTION_KEY,
          );
        }
        if (tokens.access_token) {
          updates.accessToken = tokens.access_token;
          updates.accessTokenExpiresAt = tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : new Date(Date.now() + 3_500_000);
        }
        await prisma.googleAccount.update({
          where: { id: account.id },
          data: updates,
        });
      } catch (err) {
        logger.warn({ err, accountId: account.id }, 'failed to persist rotated google tokens');
      }
    })();
  });

  const client = google.people({ version: 'v1', auth: oauth });
  return { client, oauth, account };
}

// Mark an account disabled because Google rejected the refresh token.
// The pull / push processors call this when they catch invalid_grant.
export async function disableAccount(
  accountId: number,
  reason: string,
): Promise<void> {
  await prisma.googleAccount.update({
    where: { id: accountId },
    data: { disabledAt: new Date(), disabledReason: reason },
  });
  logger.warn({ accountId, reason }, 'disabled google account');
}

// Type guards for People API errors. googleapis throws GaxiosError; we
// only care about a small set of codes for retry / fallback decisions.
export function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  if (e.response?.data?.error === 'invalid_grant') return true;
  if (typeof e.message === 'string' && /invalid_grant/i.test(e.message)) return true;
  return false;
}

export function statusCodeOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: number; status?: number; response?: { status?: number } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.response?.status === 'number') return e.response.status;
  return null;
}

// Pull the `Retry-After` header off a 429 response. Returns ms; falls
// back to a reasonable default when the header is missing.
export function retryAfterMs(err: unknown): number {
  const e = err as { response?: { headers?: Record<string, string> } } | undefined;
  const hdr = e?.response?.headers?.['retry-after'];
  if (hdr) {
    const seconds = Number(hdr);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 5 * 60_000);
  }
  return 60_000;
}
