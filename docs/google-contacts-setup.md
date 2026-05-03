# Google Contacts integration — setup

This guide walks through everything needed to enable the **Settings → Integrations → Google** flow in PipelineFlow. Once configured, each PF user can connect their own Google account and PipelineFlow will pull their Google contacts on a schedule (and optionally push their PF edits back).

If you're not sure why you'd want this, see the **Google Contacts integration** section in the project's main [README](../README.md).

---

## Prerequisites

You'll need:

1. **A Google Cloud account** (free tier is fine — no billing required for People API at the volume PipelineFlow generates).
2. **A public HTTPS hostname for PipelineFlow.** Google's OAuth flow refuses any redirect URI that isn't `https://...` or `http://localhost`. If you're running on a LAN-only address like `http://crm.myserver.local`, you need a tunnel — see [`public-hostname-setup.md`](./public-hostname-setup.md). For local dev on the same machine you sign in from, `http://localhost:5173` works without a tunnel.
3. **Operator access to the PipelineFlow stack** — you'll need to set environment variables and restart the api + worker containers.

---

## Step 1 — Create a Google Cloud project

1. Open <https://console.cloud.google.com>.
2. Top bar → project dropdown → **New Project**. Name it something like `pipelineflow-prod`. The project is just an organizational container; you don't need a separate one per environment unless you want isolated quotas / consent screens.
3. Wait ~10 seconds for the project to provision; the dropdown will switch to it automatically.

## Step 2 — Enable the People API

The OAuth client itself doesn't activate any APIs — you do that separately.

1. Left nav → **APIs & Services → Library**.
2. Search for **People API**.
3. Click it → **Enable**. (Confirms in a few seconds.)

If you skip this step, the consent screen will appear to work but every worker call will 403 with "People API has not been used in project ... before or it is disabled."

## Step 3 — Configure the OAuth consent screen

This controls what users see when they hit "Connect Google account."

1. Left nav → **APIs & Services → OAuth consent screen**.
2. **User type**:
   - **External** if your users have personal Gmail / non-Workspace accounts. Required unless every user is in the same Workspace org.
   - **Internal** if you're a Workspace org and only Workspace members will connect.
3. Fill in:
   - **App name** — e.g. `PipelineFlow`.
   - **User support email** — yours.
   - **App logo** — optional.
   - **Developer contact** — yours.
4. **Scopes** — click *Add or Remove Scopes* and add exactly these three:
   - `.../auth/contacts` (read & write Google contacts)
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
5. **Test users** (External + Testing mode only) — add the email of every account that will connect. Until you publish the app, only listed test users can complete the consent flow; everyone else gets a "this app hasn't been verified" block.
6. Save. You can leave the app in **Testing** mode indefinitely if you only have a small known group of users — it just means you cap at 100 test users and tokens issued during testing expire after 7 days. To skip those caps, click **Publish app** (no formal verification needed for the contacts scope at small volumes; you'll only need verification if you ever ask for restricted scopes like Gmail read).

## Step 4 — Create the OAuth client

1. Left nav → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID**.
3. **Application type** — **Web application**.
4. **Name** — anything, e.g. `PipelineFlow web`.
5. **Authorized JavaScript origins** — leave empty for this flow (server-side OAuth, no JS-initiated calls to Google).
6. **Authorized redirect URIs** — add the URL Google will send users back to after consent. Must match `GOOGLE_OAUTH_REDIRECT_URI` (next section) **byte-for-byte**, including scheme, port, path, and trailing slashes.
   - **Production**: `https://crm.example.com/api/integrations/google/callback`
   - **Local dev (same machine)**: `http://localhost:5173/api/integrations/google/callback`
   - **Both at once is fine** — you can add multiple. Useful for keeping a localhost entry alongside production.
7. **Create**. Copy the **Client ID** and **Client secret** that appear in the modal — you'll need them in the next step. The secret can be retrieved later, but only by re-opening the client.

### What Google won't accept

You may have already discovered some of these the hard way:

| Hostname | Allowed? | Why |
|---|---|---|
| `https://crm.example.com` | ✅ | Public DNS + HTTPS. |
| `http://localhost:5173` | ✅ | The literal word `localhost` is HTTP-allowed. |
| `http://127.0.0.1:5173` | ❌ | Numeric loopback isn't allowed; use `localhost`. |
| `http://crm.myserver.local` | ❌ | `.local` is on Google's blocklist. |
| `http://crm.lan` / `http://crm.home.arpa` | ❌ | Same — reserved/non-public TLDs. |
| `https://192.168.1.10` | ❌ | Numeric IPs aren't accepted as redirect URIs. |
| `https://crm.example.com/api/integrations/google/callback/` | ❌ | Trailing slash mismatch with the env var = "redirect_uri_mismatch" at runtime. |

If your only access pattern is a LAN address, use [Cloudflare Tunnel or Tailscale Funnel](./public-hostname-setup.md) to get a real HTTPS URL.

## Step 5 — Generate the token-encryption key

PipelineFlow stores each user's Google refresh token in the database, wrapped with AES-256-GCM. The key is operator-supplied — losing it means every connected user has to reconnect, but stealing the database without the key gets the attacker nothing.

```bash
openssl rand -base64 32
```

The output is a 44-character base64 string. Save it — that's `GOOGLE_TOKEN_ENCRYPTION_KEY`. Treat it like any other secret (don't commit it, don't paste it into chat).

## Step 6 — Set env vars on the stack

Add five variables. The first three come from the OAuth client, the fourth from `openssl rand`, the fifth is optional.

```
GOOGLE_OAUTH_CLIENT_ID=46213580400-xxxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_OAUTH_REDIRECT_URI=https://crm.example.com/api/integrations/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=<the openssl output>
GOOGLE_CONTACTS_SYNC_INTERVAL_MS=600000
```

The first four are also required on the **worker** container (it decrypts and refreshes tokens). The api uses `GOOGLE_OAUTH_REDIRECT_URI` for the start-of-flow URL; the worker doesn't need it. `GOOGLE_CONTACTS_SYNC_INTERVAL_MS` only matters on the api (which schedules the cron); it defaults to 600000 (10 minutes) if omitted.

In docker-compose.yml the environment block already references these — so editing your `.env` (CLI) or stack environment (Portainer) is enough; no compose changes needed.

After updating env, restart the api and worker so they pick up the new values:

```
docker compose up -d api worker
```

## Step 7 — Connect from the UI

1. Sign into PipelineFlow.
2. **Settings → Integrations**.
3. Click **Connect Google account**. The browser navigates to Google's consent screen.
4. Pick the Google account you want to connect (must be on the test-user list if your consent screen is in Testing mode).
5. Approve the requested scopes (Contacts + your email/profile).
6. Google redirects back to `/settings/integrations?google=connected`. A toast confirms; the page swaps from the Connect button to the connected state with last-pulled timestamps.
7. The initial bulk import starts immediately. For an address book with thousands of contacts it'll run in the background — the Settings page polls and shows progress (`imported so far: N`).

## Step 8 — Verify the cron is running

The pull cron is registered automatically when an account is connected and re-registered on every api boot.

- **bull-board** — visit `/admin/queues` (auth-required, gated by `BULL_BOARD_ENABLED=true` which is the default). The `google-contacts-pull` queue should show a recurring job named `recurring:google-contacts-pull:<accountId>` ticking every 10 minutes.
- **Last pulled timestamp** on Settings → Integrations updates each run.
- **Manual trigger** — the **Resync now** button on the same page fires an on-demand pull. Useful for verifying without waiting for the next cron tick.

## Optional — Enable outbound (push to Google)

By default, PipelineFlow only pulls *from* Google. Enabling **outbound** also pushes your PF contact create/update/delete events to your Google address book.

- Settings → Integrations → toggle **"Push my PipelineFlow edits back to Google Contacts"**.
- It's per-user — flipping the toggle only enables outbound for *your* connected account, never for other users on the workspace.
- Pushes are echo-loop guarded: a contact PF just received from Google won't ricochet back as a push.

---

## Troubleshooting

### "Google integration isn't configured on this server"

The api can't see one of `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY`. Check:

```
docker compose exec api printenv | grep GOOGLE
```

All four must appear with non-empty values. If they don't, the variables aren't reaching the container — Portainer needs them in the stack's *Environment variables* section, the CLI reads from `.env` adjacent to the compose file. Restart the container after fixing.

### "redirect_uri_mismatch" on the consent screen

The string in `GOOGLE_OAUTH_REDIRECT_URI` doesn't match what's in the OAuth client's **Authorized redirect URIs**. Google compares the full URL byte-for-byte — scheme, host, port, path, trailing slash. The most common cause is a trailing `/` in one place and not the other.

### "This app isn't verified" block on consent

Your OAuth consent screen is in Testing mode and the user trying to connect isn't on the test-user list. Either add them or publish the app.

### Can't read GoogleAccount table

Symptom: api logs show `The table "public.GoogleAccount" does not exist in the current database.` The migration didn't run. Force it:

```
docker compose exec api pnpm --filter @pipelineflow/api exec prisma migrate deploy
```

Then restart the api.

### "Connection disabled (invalid_grant)"

Google rejected the stored refresh token — the user revoked access at <https://myaccount.google.com/permissions>, or the password was reset, or the token expired after long disuse. The Settings page will show a red banner; the user clicks **Connect Google account** again and the next consent flow restores it (existing link rows are kept, etags warm-start).

### Contacts not appearing in PF

In order of likelihood:
1. **Initial import still in progress** — large address books take several pull-cycles. Watch `initialImportedCount` on the Settings page.
2. **The cron isn't running** — check `/admin/queues` for the `recurring:google-contacts-pull:<accountId>` job. If it's missing, restart the api (the boot path re-registers schedules for every connected account).
3. **`inboundEnabled` is false** — only set if someone disconnected mid-flow. Reconnect to reset.
4. **The contact doesn't have a name or email** — PipelineFlow skips Google entries that lack both.

### Worker logs show "GOOGLE_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes"

The base64 you pasted decodes to fewer than 32 bytes. Regenerate with `openssl rand -base64 32` and paste the entire 44-character output (no surrounding quotes, no truncation).
