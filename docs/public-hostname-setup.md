# Public hostname setup (for Google OAuth and other integrations)

PipelineFlow's Google integration needs a publicly-resolvable HTTPS URL — Google's OAuth flow refuses redirect URIs on `.local`, `.lan`, IP literals, or plain HTTP (with the single exception of `http://localhost`). If your homelab is LAN-only, you need to expose PipelineFlow at a real hostname for the OAuth dance to work.

This doc covers two ways to do it without opening inbound ports on your firewall: **Cloudflare Tunnel** (more polished URL, requires a domain) and **Tailscale Funnel** (no DNS work, but the URL is `<machine>.<tailnet>.ts.net`).

If you don't need Google integration and don't anticipate other integrations that require a public callback, you can ignore this entire doc — running PipelineFlow on `http://localhost` or `http://crm.myserver.local` is fine for everything else.

---

## Why a tunnel?

Both Cloudflare Tunnel and Tailscale Funnel work the same way at the high level: a small daemon runs on your server and makes an **outbound** TLS connection to the provider's edge. When public traffic arrives at your assigned URL, it flows down through that tunnel into your server. Your firewall stays closed; you never open port 80, 443, or anything else inbound.

The provider terminates TLS at their edge with a real cert (Let's Encrypt or their own CA), so Google's OAuth flow gets the `https://...` it requires.

Compared to traditional port-forwarding + Let's Encrypt:
- No router config.
- No public IP needed (works behind CGNAT, tethered connections, etc.).
- No cert renewal to manage.
- Survives ISP IP changes.

---

## Option 1 — Cloudflare Tunnel

Best if you have a domain you can manage on Cloudflare DNS. Free.

### Prerequisites

- A domain (e.g. `example.com`). If you only have one elsewhere, you can either move the whole zone to Cloudflare DNS or buy a cheap second domain just for this. Cloudflare's free plan **does not** allow adding individual subdomains as zones — that feature is paid only.
- An hour for first-time DNS migration if you're moving an existing zone.

### Step 1 — Move DNS to Cloudflare

If your domain is already on Cloudflare, skip to Step 2.

If it's elsewhere (Route 53, GoDaddy, Namecheap…):

1. **Cloudflare** → **Add a site** → enter the **root** domain (e.g. `example.com`, not `crm.example.com`).
2. Pick the **Free** plan.
3. Cloudflare scans your existing DNS and imports records. **Review the imported list carefully** before continuing — anything missing won't resolve once you cut over.
4. Cloudflare gives you two nameservers (e.g. `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`).
5. At your **registrar** (where you bought the domain — could be the same provider that hosts the DNS, or different), update the nameservers to the two Cloudflare gave you.
6. Propagation takes anywhere from a few minutes to a few hours. Cloudflare emails you when active.
7. Don't delete the old DNS host's records yet. Keep them as a backup until you've verified everything resolves through Cloudflare.

### Step 2 — Create the tunnel

1. Cloudflare → **Zero Trust** dashboard at <https://one.dash.cloudflare.com>.
2. **Networks → Tunnels → Create a tunnel**.
3. **Connector type**: Cloudflared.
4. Name it (e.g. `myserver`, `bizserver`, etc), save.
5. Cloudflare shows an install command for your OS — copy and run it on the server hosting PipelineFlow. It installs `cloudflared`, registers it as a systemd service, and starts it automatically. The command embeds your tunnel's secret token, so don't share the screenshot.
6. Within ~30 seconds, the dashboard's tunnel status flips to **Healthy**.

### Step 3 — Route a hostname to PipelineFlow

In the same tunnel's **Public Hostnames** tab, click **Add a public hostname**:

- **Subdomain**: e.g. `crm`
- **Domain**: e.g. `example.com` (only domains you've added to Cloudflare appear in this dropdown)
- **Service**: `HTTP`
- **URL**: `localhost:5173` (or whichever port your `web` container exposes on the host — `${WEB_PORT:-5173}` from the compose file)

Save. Cloudflare creates the DNS record automatically. After ~30 seconds you can hit `https://crm.example.com` from anywhere — it terminates TLS at Cloudflare's edge and tunnels to your server.

### Step 4 — Update PipelineFlow env

```
APP_ORIGIN=https://crm.example.com
GOOGLE_OAUTH_REDIRECT_URI=https://crm.example.com/api/integrations/google/callback
```

Restart api + worker to pick up the changes (`docker compose up -d api worker`). Add the matching redirect URI to your Google OAuth client (see [`google-contacts-setup.md`](./google-contacts-setup.md) Step 4).

### Use it from the LAN too

After this is set up, **use the public URL even when you're on the LAN**. It's a small latency hit (out-and-back through Cloudflare's edge), but the alternative — accessing via `http://crm.myserver.local` for normal use, then jumping to `https://crm.example.com` for OAuth — splits browser session cookies between two origins and breaks the OAuth callback.

If you really want LAN users on the LAN URL, the OAuth callback flow needs a code change so it doesn't depend on a session cookie. File an issue if you want that path.

---

## Option 2 — Tailscale Funnel

Best if you don't have (or don't want to migrate) a domain. Free for personal use. Doesn't touch DNS at all.

The trade-off: the URL is `<machine>.<tailnet>.ts.net` rather than something pretty like `crm.example.com`. Functional and HTTPS, but visibly third-party.

### Step 1 — Install Tailscale

If you don't already have it on the myserver:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The `up` command prints a URL — open it in a browser and sign in with the account you'll use for your tailnet.

### Step 2 — Allow Funnel on your tailnet

Open <https://login.tailscale.com/admin/acls/file>. In the ACL JSON, add (or extend) a `nodeAttrs` block:

```json
{
  "nodeAttrs": [
    {
      "target": ["*"],
      "attr":   ["funnel"]
    }
  ]
}
```

Save. (You can scope `target` to a specific machine instead of `*` if you want to limit Funnel to only your myserver.)

### Step 3 — Expose PipelineFlow

On the myserver:

```bash
sudo tailscale funnel 5173
```

Tailscale prints the public URL — something like `https://myserver.tail-scale.ts.net`. The `5173` is whichever host port your `web` container is bound to.

To make it persistent across reboots:

```bash
sudo tailscale funnel --bg 5173
```

### Step 4 — Update PipelineFlow env + Google OAuth

```
APP_ORIGIN=https://myserver.tail-scale.ts.net
GOOGLE_OAUTH_REDIRECT_URI=https://myserver.tail-scale.ts.net/api/integrations/google/callback
```

Restart api + worker. Add the same URL as an Authorized redirect URI in your Google OAuth client.

### Quirks

- The `<tailnet>` portion of the URL is auto-generated (`tail-scale.ts.net`, `tail-XXXX.ts.net`, etc.). It's stable for a given tailnet but isn't pretty. You can rename your tailnet in the admin UI to get a slightly nicer one (e.g. `yourname.ts.net`) but the `.ts.net` parent is fixed.
- Funnel tunnels through Tailscale's coordination servers, which adds a small latency vs. Cloudflare Tunnel for the same geographic distance. Not noticeable for OAuth flows, but heavier integrations might feel it.
- Free plan limits: 1 GB/mo of Funnel egress and a few connection limits. Plenty for OAuth callbacks; not for serving a high-traffic public site.

---

## Both? Neither?

You only need one. If you already have a domain you don't mind moving to Cloudflare DNS, **Cloudflare Tunnel** is the better long-term choice — prettier URL, higher limits, more flexible config. If you don't have a domain or your existing one has too much production AWS infrastructure to migrate easily, **Tailscale Funnel** gets you running today with zero DNS work.

If you don't need any external integrations at all, **don't bother with either** — PipelineFlow runs fine on a LAN-only address. You'll just be unable to wire up Google Contacts (and presumably future Gmail / Calendar integrations).

---

## Common pitfalls

- **Google still rejects the redirect URI after setup** — Google's check is byte-for-byte. Make sure `GOOGLE_OAUTH_REDIRECT_URI` and the OAuth client's Authorized redirect URIs match exactly: same scheme (`https://`), same host, same path (`/api/integrations/google/callback`), no trailing slash on one and not the other.
- **APP_ORIGIN mismatch** — `APP_ORIGIN` in PF env must match the public URL too. The api uses it for CORS, cookie domain, and CSRF Origin/Referer checks. If APP_ORIGIN is the LAN URL but you're hitting via the public one, mutating requests will 403 with "Origin not allowed."
- **Tunnel daemon disconnects** — Cloudflared and Tailscale both auto-reconnect, but check `systemctl status cloudflared` (or `tailscale status`) if `/healthz` returns OK on the host but the public URL times out.
- **`crm.myserver.local` still in browser bookmarks** — easy to forget you switched. Cookie domain mismatch will look like "I'm logged out every time."
