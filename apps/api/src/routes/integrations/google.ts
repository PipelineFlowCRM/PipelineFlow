import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { requireUserSession } from '../../auth/middleware.js';
import { asyncHandler, HttpError } from '../../lib/error.js';
import { logger } from '../../lib/logger.js';
import {
  enqueueGoogleCalendarPull,
  enqueueGoogleContactsPull,
  ensureGoogleCalendarPullScheduled,
  ensureGoogleContactsPullScheduled,
  unscheduleGoogleCalendarPull,
  unscheduleGoogleContactsPull,
} from '../../lib/queue.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';
import { invalidateOutboundCache } from '../../integrations/google/enqueuePushIfConnected.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  isConfigured,
  revokeRefreshToken,
  SCOPES_FOR_INTENT,
  type GoogleIntent,
} from '../../integrations/google/oauthClient.js';

// All four endpoints sit under /api/integrations/google. They drive the
// per-user Google connection lifecycle: start consent → handle callback
// → expose status to the settings page → disconnect. None of these are
// reachable by API tokens — Google connections belong to a real user, so
// we use requireUserSession to block bearer auth.

export const googleIntegrationRouter = Router();
googleIntegrationRouter.use(requireUserSession);

const STATE_TTL_MS = 10 * 60_000;

// Short, well-defined intent set keeps the route layer agnostic about
// which Google APIs are wired up. Add a string here when you ship the
// next integration; the OAuth client looks the scope set up.
const startQuerySchema = z.object({
  intent: z.enum(['contacts', 'calendar']).default('contacts'),
});

googleIntegrationRouter.get(
  '/start',
  asyncHandler(async (req, res) => {
    if (!isConfigured()) {
      throw new HttpError(503, 'Google integration is not configured on this server');
    }
    const { intent } = startQuerySchema.parse({ intent: req.query.intent });
    const scopes = SCOPES_FOR_INTENT[intent as GoogleIntent];
    if (!scopes) throw new HttpError(400, 'Unknown intent');

    // Opportunistic cleanup of stale state rows. Cheap (indexed delete)
    // and bounds the table without needing a separate cron. We delete
    // anything expired, anything consumed > 24h ago, and any prior
    // unconsumed state owned by this user (a fresh /start supersedes
    // it). The 24h floor on consumed rows keeps recent successes around
    // for log-correlating an OAuth dance after the fact.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    await prisma.oAuthState
      .deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            { consumedAt: { lt: dayAgo } },
            { userId: req.user!.id, consumedAt: null },
          ],
        },
      })
      .catch(() => {
        // Cleanup is best-effort; never block a connection on it.
      });

    // 32 bytes = 256 bits of entropy; matches the session-token convention.
    const stateId = randomBytes(32).toString('base64url');
    await prisma.oAuthState.create({
      data: {
        id: stateId,
        userId: req.user!.id,
        provider: 'google',
        intent,
        scopes: scopes as unknown as object,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    const url = buildAuthUrl(scopes, stateId);
    // Return the URL rather than 302-redirecting so the SPA can decide
    // how to navigate (window.location vs. opening a popup). Same pattern
    // as we'd use for Stripe Connect or any other consent-screen flow.
    res.json({ url });
  }),
);

googleIntegrationRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    // Google redirects here with ?code=...&state=... — or with ?error=...
    // when the user denies. We always redirect back to the SPA's
    // integrations page so the user lands somewhere recognisable.
    const fail = (msg: string) => {
      const target = `${env.APP_ORIGIN}/settings/integrations?google=error&reason=${encodeURIComponent(msg)}`;
      res.redirect(target);
    };
    const ok = () => {
      const target = `${env.APP_ORIGIN}/settings/integrations?google=connected`;
      res.redirect(target);
    };

    const errorParam = typeof req.query.error === 'string' ? req.query.error : null;
    if (errorParam) {
      logger.info({ err: errorParam }, 'google oauth callback returned error');
      return fail(errorParam);
    }
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const stateId = typeof req.query.state === 'string' ? req.query.state : null;
    if (!code || !stateId) return fail('missing_code_or_state');

    // Atomic compare-and-set: a single UPDATE that only matches an
    // unconsumed, unexpired row owned by this user. Race-safe against
    // double-clicks (single state can't be consumed twice) without
    // relying on transaction isolation. Postgres returns the count of
    // rows that matched — anything other than 1 means invalid.
    const claim = await prisma.oAuthState.updateMany({
      where: {
        id: stateId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        userId: req.user!.id,
      },
      data: { consumedAt: new Date() },
    });
    if (claim.count !== 1) return fail('invalid_state');
    const state = await prisma.oAuthState.findUnique({ where: { id: stateId } });
    if (!state) return fail('invalid_state');

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code);
    } catch (err) {
      logger.warn({ err }, 'google oauth code exchange failed');
      return fail('code_exchange_failed');
    }
    if (!tokens.googleSub) return fail('missing_id_token');

    const encrypted = encryptSecret(tokens.refreshToken, env.GOOGLE_TOKEN_ENCRYPTION_KEY);

    // Upsert the GoogleAccount row keyed on userId. If this user already
    // has a connection (e.g. reconnecting after an `invalid_grant`), we
    // overwrite the encrypted token + refresh metadata and clear the
    // disabled flags so the worker resumes on next run.
    const account = await prisma.$transaction(async (tx) => {
      const existing = await tx.googleAccount.findUnique({
        where: { userId: req.user!.id },
      });
      if (existing) {
        return tx.googleAccount.update({
          where: { id: existing.id },
          data: {
            googleSub: tokens.googleSub!,
            googleEmail: tokens.googleEmail ?? existing.googleEmail,
            encryptedRefreshToken: encrypted,
            scopes: tokens.scopes as unknown as object,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            connectedAt: new Date(),
            lastRefreshedAt: new Date(),
            disabledAt: null,
            disabledReason: null,
          },
        });
      }
      return tx.googleAccount.create({
        data: {
          userId: req.user!.id,
          googleSub: tokens.googleSub!,
          googleEmail: tokens.googleEmail ?? '',
          encryptedRefreshToken: encrypted,
          scopes: tokens.scopes as unknown as object,
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          lastRefreshedAt: new Date(),
        },
      });
    });

    // Initialise the per-integration child row + kick off the initial
    // pull. Each intent owns its own child table — adding a third
    // integration (Gmail) lands here as another branch.
    if (state.intent === 'contacts') {
      await prisma.googleContactsSync.upsert({
        where: { googleAccountId: account.id },
        create: { googleAccountId: account.id },
        update: {
          // Reconnecting clears the in-progress import state so we start
          // fresh — the previous run's link rows are kept (etag warm-start),
          // but the user-visible counter resets to 0 so the UI doesn't
          // show stale "imported so far: N" carry-over.
          initialPageToken: null,
          fullSyncDoneAt: null,
          initialImportedCount: 0,
        },
      });
      try {
        await enqueueGoogleContactsPull({
          kind: 'initial',
          googleAccountId: account.id,
        });
        await ensureGoogleContactsPullScheduled(account.id);
      } catch (err) {
        // Don't fail the connection if Redis is briefly unreachable —
        // the user's account is connected and the next manual resync (or
        // boot of the api) will catch up. Surface in logs so an op can
        // investigate.
        logger.error(
          { err, googleAccountId: account.id },
          'failed to enqueue initial contacts pull',
        );
      }
    } else if (state.intent === 'calendar') {
      await prisma.googleCalendarSync.upsert({
        where: { googleAccountId: account.id },
        create: { googleAccountId: account.id },
        update: {
          // Reconnecting drops the delta token so the next pull does a
          // bounded re-list of the lookback window — picks up anything
          // that happened while the connection was down without us
          // having to think about state reconciliation.
          eventsSyncToken: null,
          // Re-enable sync on reconnect. If the row was previously left
          // disabled (e.g. after an invalid_grant teardown), the user has
          // no UI path to flip it back on, so a calendar reconnect would
          // silently no-op forever in the pull job's `!sync.enabled` guard.
          enabled: true,
        },
      });
      try {
        await enqueueGoogleCalendarPull({
          kind: 'incremental',
          googleAccountId: account.id,
        });
        await ensureGoogleCalendarPullScheduled(account.id);
      } catch (err) {
        logger.error(
          { err, googleAccountId: account.id },
          'failed to enqueue initial calendar pull',
        );
      }
    }

    return ok();
  }),
);

const statusOutSchema = z.object({
  connected: z.boolean(),
  configured: z.boolean(),
  account: z
    .object({
      googleEmail: z.string(),
      scopes: z.array(z.string()),
      connectedAt: z.string(),
      disabledAt: z.string().nullable(),
      disabledReason: z.string().nullable(),
    })
    .nullable(),
  contacts: z
    .object({
      inboundEnabled: z.boolean(),
      outboundEnabled: z.boolean(),
      fullSyncDoneAt: z.string().nullable(),
      lastPulledAt: z.string().nullable(),
      lastPushedAt: z.string().nullable(),
      initialImportedCount: z.number(),
    })
    .nullable(),
  calendar: z
    .object({
      enabled: z.boolean(),
      lastEventsSyncedAt: z.string().nullable(),
      lastArtifactsSyncedAt: z.string().nullable(),
    })
    .nullable(),
});

googleIntegrationRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const account = await prisma.googleAccount.findUnique({
      where: { userId: req.user!.id },
      include: { contactsSync: true, calendarSync: true },
    });
    const out: z.infer<typeof statusOutSchema> = {
      connected: Boolean(account && !account.disabledAt),
      configured: isConfigured(),
      account: account
        ? {
            googleEmail: account.googleEmail,
            scopes: Array.isArray(account.scopes) ? (account.scopes as unknown as string[]) : [],
            connectedAt: account.connectedAt.toISOString(),
            disabledAt: account.disabledAt?.toISOString() ?? null,
            disabledReason: account.disabledReason,
          }
        : null,
      contacts: account?.contactsSync
        ? {
            inboundEnabled: account.contactsSync.inboundEnabled,
            outboundEnabled: account.contactsSync.outboundEnabled,
            fullSyncDoneAt: account.contactsSync.fullSyncDoneAt?.toISOString() ?? null,
            lastPulledAt: account.contactsSync.lastPulledAt?.toISOString() ?? null,
            lastPushedAt: account.contactsSync.lastPushedAt?.toISOString() ?? null,
            initialImportedCount: account.contactsSync.initialImportedCount,
          }
        : null,
      calendar: account?.calendarSync
        ? {
            enabled: account.calendarSync.enabled,
            lastEventsSyncedAt: account.calendarSync.lastEventsSyncedAt?.toISOString() ?? null,
            lastArtifactsSyncedAt:
              account.calendarSync.lastArtifactsSyncedAt?.toISOString() ?? null,
          }
        : null,
    };
    res.json(out);
  }),
);

const settingsSchema = z.object({
  outboundEnabled: z.boolean().optional(),
});

googleIntegrationRouter.patch(
  '/contacts/settings',
  asyncHandler(async (req, res) => {
    const body = settingsSchema.parse(req.body ?? {});
    const account = await prisma.googleAccount.findUnique({
      where: { userId: req.user!.id },
      include: { contactsSync: true },
    });
    if (!account || !account.contactsSync) {
      throw new HttpError(404, 'No Google contacts connection');
    }
    const updated = await prisma.googleContactsSync.update({
      where: { googleAccountId: account.id },
      data: {
        ...(body.outboundEnabled !== undefined ? { outboundEnabled: body.outboundEnabled } : {}),
      },
    });
    invalidateOutboundCache();
    res.json({
      outboundEnabled: updated.outboundEnabled,
      inboundEnabled: updated.inboundEnabled,
    });
  }),
);

googleIntegrationRouter.post(
  '/calendar/resync',
  asyncHandler(async (req, res) => {
    const account = await prisma.googleAccount.findUnique({
      where: { userId: req.user!.id },
      include: { calendarSync: true },
    });
    if (!account || account.disabledAt) {
      throw new HttpError(409, 'Google account not connected');
    }
    if (!account.calendarSync) {
      throw new HttpError(404, 'No calendar sync configured — reconnect with the calendar intent');
    }
    await enqueueGoogleCalendarPull({ kind: 'incremental', googleAccountId: account.id });
    res.json({ enqueued: 'incremental' });
  }),
);

// Drops the Calendar delta token and re-pulls the configured lookback
// window (currently 90 days). Useful when an account connected before
// the wider lookback shipped, or when the rep wants to pull in older
// meetings they need to attach to a deal manually. Idempotent.
googleIntegrationRouter.post(
  '/calendar/backfill',
  asyncHandler(async (req, res) => {
    const account = await prisma.googleAccount.findUnique({
      where: { userId: req.user!.id },
      include: { calendarSync: true },
    });
    if (!account || account.disabledAt) {
      throw new HttpError(409, 'Google account not connected');
    }
    if (!account.calendarSync) {
      throw new HttpError(404, 'No calendar sync configured');
    }
    await prisma.googleCalendarSync.update({
      where: { googleAccountId: account.id },
      data: { eventsSyncToken: null },
    });
    await enqueueGoogleCalendarPull({ kind: 'incremental', googleAccountId: account.id });
    res.json({ enqueued: 'backfill' });
  }),
);

googleIntegrationRouter.post(
  '/contacts/resync',
  asyncHandler(async (req, res) => {
    const account = await prisma.googleAccount.findUnique({
      where: { userId: req.user!.id },
      include: { contactsSync: true },
    });
    if (!account || account.disabledAt) {
      throw new HttpError(409, 'Google account not connected');
    }
    if (!account.contactsSync) {
      throw new HttpError(404, 'No contacts sync configured');
    }
    // Initial run if we never finished the bulk import (e.g. user
    // disconnected mid-run); otherwise an incremental delta. Cron-deduped
    // by jobId, so a click while a cron run is queued collapses cleanly.
    const kind = account.contactsSync.fullSyncDoneAt ? 'incremental' : 'initial';
    await enqueueGoogleContactsPull({ kind, googleAccountId: account.id });
    res.json({ enqueued: kind });
  }),
);

googleIntegrationRouter.post(
  '/disconnect',
  asyncHandler(async (req, res) => {
    const account = await prisma.googleAccount.findUnique({
      where: { userId: req.user!.id },
    });
    if (!account) {
      res.json({ disconnected: false });
      return;
    }
    // Best-effort revoke at Google. Don't await this critical path — if
    // Google's revoke endpoint is slow or down, the user still expects
    // the disconnect button to work. Soft-delete locally regardless.
    let plaintext: string | null = null;
    try {
      plaintext = decryptSecret(account.encryptedRefreshToken, env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    } catch (err) {
      logger.warn({ err }, 'could not decrypt refresh token for revoke');
    }
    if (plaintext) void revokeRefreshToken(plaintext);

    await prisma.googleAccount.update({
      where: { id: account.id },
      data: {
        disabledAt: new Date(),
        disabledReason: 'user_disconnected',
        // Wipe the cached access token so a stale value can't be used
        // by an in-flight job; the encrypted refresh token stays so a
        // reconnect can warm-start with the same etags.
        accessToken: null,
        accessTokenExpiresAt: null,
      },
    });
    await prisma.googleContactsSync.updateMany({
      where: { googleAccountId: account.id },
      data: { inboundEnabled: false, outboundEnabled: false },
    });
    await prisma.googleCalendarSync.updateMany({
      where: { googleAccountId: account.id },
      data: { enabled: false },
    });
    try {
      await unscheduleGoogleContactsPull(account.id);
    } catch (err) {
      logger.warn({ err }, 'failed to unschedule google contacts pull');
    }
    try {
      await unscheduleGoogleCalendarPull(account.id);
    } catch (err) {
      logger.warn({ err }, 'failed to unschedule google calendar pull');
    }
    invalidateOutboundCache();
    res.json({ disconnected: true });
  }),
);
