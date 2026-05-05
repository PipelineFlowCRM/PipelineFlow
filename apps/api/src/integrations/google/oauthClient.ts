import { OAuth2Client } from 'google-auth-library';
import { env } from '../../env.js';

// Single source of truth for Google OAuth from the api process. Wraps
// google-auth-library so the routes don't pull google-auth-library types
// directly — keeps the surface area small and means future swaps (a
// different SDK, mocking in tests) only touch this file.
//
// The OAuth dance has three pieces:
//   1. /start — generate a consent URL the browser is redirected to. The
//      consent URL embeds the requested scopes; with `prompt=consent` and
//      `access_type=offline` we always get a refresh token back, even on
//      a re-consent.
//   2. /callback — exchange the authorization code for an access token +
//      refresh token + id_token, then read the id_token to identify the
//      Google user (`sub` is stable, `email` is convenient for UI).
//   3. background — every time we want to talk to a Google API, mint a
//      fresh access token from the stored refresh token via
//      `clientForRefreshToken(...)`. The `tokens` event lets us catch
//      Google rotating the refresh token (rare but real) so we can
//      re-encrypt and persist.
//
// We intentionally don't keep a long-lived OAuth2Client per account in
// memory: the api process is multi-instance, so tokens have to come from
// the DB on every request anyway. Construct, use, dispose.

export const SCOPE_CONTACTS = 'https://www.googleapis.com/auth/contacts';
export const SCOPE_USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
export const SCOPE_USERINFO_PROFILE = 'https://www.googleapis.com/auth/userinfo.profile';
// Calendar: read-only is enough for v1. We never write the user's calendar
// (briefing-doc-on-event-description is a future spec), so the .events
// scope would be over-broad.
export const SCOPE_CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
// Meet conferenceRecords / recordings / transcripts. The Meet REST API
// gates these behind their own scope; we ask for it as part of the
// calendar intent because a connected calendar without Meet artifacts is
// a thin slice and forcing two separate consent screens would be a worse
// rep experience.
export const SCOPE_MEET_READONLY = 'https://www.googleapis.com/auth/meetings.space.readonly';
// Drive metadata — needed to search the organizer's Drive for the
// "Notes by Gemini" summary Doc, which is *not* exposed through the Meet
// API. We don't ask for full Drive read; metadata is enough to find the
// file and build a public link, and we never read the raw file bytes
// (the summary parser needs the doc body, so it asks for documents.readonly
// below — see the comment there for why we still want the narrow scope).
export const SCOPE_DRIVE_METADATA_READONLY = 'https://www.googleapis.com/auth/drive.metadata.readonly';
// Documents.readonly to read the Gemini summary doc body and extract the
// excerpt + action items. Strictly narrower than drive.readonly because
// it doesn't grant access to arbitrary file bytes; only Docs.
export const SCOPE_DOCUMENTS_READONLY = 'https://www.googleapis.com/auth/documents.readonly';

// Future intents register here — adding Gmail is a one-line change plus
// the new scope constant. The /start route accepts an intent string and
// looks up the matching scope set; that keeps the route layer agnostic
// about which APIs are configured.
export const SCOPES_FOR_INTENT: Record<string, readonly string[]> = {
  contacts: [SCOPE_CONTACTS, SCOPE_USERINFO_EMAIL, SCOPE_USERINFO_PROFILE],
  // Calendar bundles all four scopes the meeting ingest pipeline needs:
  //   - calendar.readonly  → list events for auto-link
  //   - meetings.space.readonly → conferenceRecord recordings + transcripts
  //   - drive.metadata.readonly → search for the Gemini summary Doc
  //   - documents.readonly → read the summary Doc body for excerpt + action items
  // We deliberately pair them as one intent: a connected calendar without
  // any of the others ships a meaningfully degraded experience (no
  // artifacts on the deal timeline), and forcing two consent screens to
  // get the full feature would be a much worse rep experience than asking
  // for the full set up front.
  calendar: [
    SCOPE_CALENDAR_READONLY,
    SCOPE_MEET_READONLY,
    SCOPE_DRIVE_METADATA_READONLY,
    SCOPE_DOCUMENTS_READONLY,
    SCOPE_USERINFO_EMAIL,
    SCOPE_USERINFO_PROFILE,
  ],
};

export type GoogleIntent = keyof typeof SCOPES_FOR_INTENT;

export function isConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REDIRECT_URI &&
      env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  );
}

function newClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  });
}

export function buildAuthUrl(scopes: readonly string[], state: string): string {
  const client = newClient();
  return client.generateAuthUrl({
    // `offline` is what gets us a refresh token; `prompt=consent` forces
    // the consent screen even when the user has already granted access,
    // which guarantees Google returns a refresh token (otherwise re-grant
    // flows skip it and the worker has nothing to mint access tokens with).
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...scopes],
    state,
  });
}

export type ExchangeResult = {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string[];
  idToken: string | null;
  // Subject (`sub`) and email pulled from the id_token. We keep them in
  // the same return so the route doesn't have to do a separate userinfo
  // call when consenting users have asked for the userinfo scopes.
  googleSub: string | null;
  googleEmail: string | null;
};

export async function exchangeCodeForTokens(code: string): Promise<ExchangeResult> {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    // Without a refresh token the integration would die the moment the
    // access token expires (~1h). This usually means a re-consent that
    // skipped issuing a new refresh token; a fresh consent prompt
    // (prompt=consent above) should always include one. Surface the
    // failure loudly so the route can ask the user to retry.
    throw new Error('Google did not return a refresh token. Retry the connection.');
  }
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token.');
  }

  // id_token is a JWT — parse without verifying the signature here (the
  // exchange already happened over TLS to Google). google-auth-library
  // exposes a verifyIdToken helper that does the JWKS round-trip; we
  // could swap this in if we ever want stricter guarantees, but for
  // pulling `sub` + `email` out of a token we just minted, the trade-off
  // isn't worth the extra request.
  let googleSub: string | null = null;
  let googleEmail: string | null = null;
  if (tokens.id_token) {
    const payload = decodeJwtPayload(tokens.id_token);
    googleSub = typeof payload.sub === 'string' ? payload.sub : null;
    googleEmail = typeof payload.email === 'string' ? payload.email : null;
  }

  const scopeStr = (tokens.scope ?? '').toString();
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  const expiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : new Date(Date.now() + 3_500_000); // ~58 minutes — Google's default

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: expiresAt,
    scopes,
    idToken: tokens.id_token ?? null,
    googleSub,
    googleEmail,
  };
}

// Returns an OAuth2Client primed with a refresh token. Caller is
// responsible for hooking the `tokens` event (refresh token rotation)
// before issuing requests — the worker module that uses this does so.
// We don't bake the listener in here because the caller needs context
// (which GoogleAccount row to update) that this layer doesn't have.
export function clientForRefreshToken(refreshToken: string): OAuth2Client {
  const client = newClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * Best-effort revoke at Google. Returns nothing — the caller (disconnect
 * route) should still proceed to soft-delete the local row whether or
 * not Google ack'd, otherwise a one-time outage on Google's side leaves
 * the user unable to disconnect.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const client = clientForRefreshToken(refreshToken);
    await client.revokeToken(refreshToken);
  } catch {
    // Already-revoked tokens 4xx; we don't care, the local row is the
    // user-visible state.
  }
}

// Shape-only JWT payload decode (no signature check — see comment in
// exchangeCodeForTokens for the reasoning).
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Detect whether a thrown error from a refresh attempt was Google saying
// "this refresh token is dead." Used by the disable path: a connected
// account that returns invalid_grant should be marked disabled so the
// user is prompted to reconnect, rather than the cron loop burning
// retries forever. google-auth-library wraps these as GaxiosError with a
// `response.data.error` of `invalid_grant`.
export function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  if (e.response?.data?.error === 'invalid_grant') return true;
  if (typeof e.message === 'string' && /invalid_grant/i.test(e.message)) return true;
  return false;
}
