import { google, type calendar_v3, type drive_v3, type docs_v1 } from 'googleapis';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { GoogleAccount } from '@prisma/client';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';
import { logger } from '../../logger.js';
import { GoogleAccountDisabledError } from './peopleClient.js';

// Client factory for the Calendar / Meet / Drive / Docs APIs we need for
// the meeting-ingest pipeline. Mirrors peopleClient.ts in shape — same
// `tokens` event handling for refresh-token rotation, same disabled-flag
// gating — but bundles four API clients off the same OAuth2Client so a
// single job run can cross APIs without re-authing.
//
// Why four clients? See spec-artifact-attach.md: Meet's REST API exposes
// recordings + transcripts but *not* the Gemini summary Doc, which only
// surfaces in Drive. We need Calendar to discover events, Meet to fetch
// conferenceRecords, Drive to find the summary by title, and Docs to read
// the summary body for excerpt + action-item extraction.

export type CalendarClient = calendar_v3.Calendar;
export type MeetClient = ReturnType<typeof google.meet>;
export type DriveClient = drive_v3.Drive;
export type DocsClient = docs_v1.Docs;

export type CalendarHandle = {
  oauth: OAuth2Client;
  calendar: CalendarClient;
  meet: MeetClient;
  drive: DriveClient;
  docs: DocsClient;
  account: GoogleAccount;
};

export async function buildCalendarHandle(account: GoogleAccount): Promise<CalendarHandle> {
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

  // Same rotation-listener pattern as peopleClient — google-auth-library
  // emits `tokens` when it rotates, and we re-encrypt + persist so a worker
  // restart immediately afterwards doesn't lose the new token.
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

  return {
    oauth,
    calendar: google.calendar({ version: 'v3', auth: oauth }),
    // The Meet REST API's `meet` client lives at v2 in googleapis. We use
    // it for conferenceRecords.recordings.list / transcripts.list — the
    // first-party path for recording / transcript metadata.
    meet: google.meet({ version: 'v2', auth: oauth }),
    drive: google.drive({ version: 'v3', auth: oauth }),
    docs: google.docs({ version: 'v1', auth: oauth }),
    account,
  };
}

