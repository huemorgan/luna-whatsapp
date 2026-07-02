---
name: render
description: >-
  Deploy and operate the luna-whatsapp gateway on Render.com — apply the blueprint,
  check deploy status, view logs, manage env vars, and query the gateway Postgres.
  Use when the user mentions Render, deploy, production, the gateway, or the
  luna-wa-db database.
---

# Render — deploy & operate the WhatsApp gateway

The gateway (`gateway/`, Node + Baileys) is the only always-on piece. It runs as a
Render **web** service (a paid web service does NOT scale-to-zero = always-on, which
Baileys needs). The Luna plugin does **not** run on Render — it runs inside Luna.

Everything Render-related is declared in `render.yaml` (the blueprint) at the repo
root. Read it before changing anything.

## What the blueprint creates (`render.yaml`)

| Resource | Name | Notes |
|----------|------|-------|
| Web service | `luna-wa-gateway` | Docker (`gateway/Dockerfile`), plan `starter`, region `oregon`, `numInstances: 1` (one socket owner), healthcheck `/health` |
| Persistent disk | `wa-auth` → `/data/wa-auth` | Holds Baileys credentials. **Never delete** — deleting forces a QR re-scan |
| Postgres | `luna-wa-db` | plan `starter`, region `oregon`, PG 16. The gateway's durable 100% capture store (source of truth) |

Env vars (`sync: false` ones are set in the dashboard, NOT in git):

| Key | Set where | Purpose |
|-----|-----------|---------|
| `WA_AUTH_DIR` | blueprint (`/data/wa-auth`) | Baileys auth dir on the disk |
| `WA_SHARED_SECRET` | dashboard | HMAC secret; must equal the plugin's `LUNA_WHATSAPP_SHARED_SECRET`. `openssl rand -hex 32` |
| `GATEWAY_ADMIN_KEY` | dashboard | protects `/qr`. `openssl rand -hex 16` |
| `LUNA_INBOUND_URL` | dashboard | `https://<your-luna-or-tunnel>/api/p/plugin-whatsapp/inbound` |
| `DATABASE_URL` | blueprint (`fromDatabase: luna-wa-db`) | gateway Postgres connection string |

## First deploy (blueprint)

1. Push this repo to a GitHub repo Render can see.
2. Render dashboard → **New → Blueprint** → pick the repo → it reads `render.yaml`
   and creates the service + disk + database.
3. Set the three `sync: false` secrets in the service's **Environment** tab:
   `WA_SHARED_SECRET`, `GATEWAY_ADMIN_KEY`, `LUNA_INBOUND_URL`.
4. Wait for the deploy to go live, then verify:

```bash
curl -s https://<gateway-host>.onrender.com/health
# expect: {status, connected, self_jid, has_qr, last_activity_at, sent_today}
```

5. Open the QR page to link a number (admin-key gated):
   `https://<gateway-host>.onrender.com/qr?key=<GATEWAY_ADMIN_KEY>`

## Redeploys

Auto-deploys on push to the connected branch, or trigger a **Manual Deploy** from the
dashboard. Redeploys reconnect the socket from the disk auth — **no re-scan**.

## Fill these in once deployed (leave TODO until then)

The Render MCP was not reachable at setup time, so real IDs aren't captured yet.
After the first deploy, record them here so future ops are one command away:

| Field | Value |
|-------|-------|
| Service name | `luna-wa-gateway` |
| Service ID | `srv-________________` (TODO) |
| Service URL | `https://________.onrender.com` (TODO) |
| Database name | `luna-wa-db` |
| Database ID | `dpg-________________` (TODO) |
| Region | oregon |
| Repo / branch | `________________` / `main` |
| Dashboard | `https://dashboard.render.com/web/srv-________` (TODO) |

## Render MCP (preferred once working)

An MCP server `user-render` is configured. When it's healthy, prefer it over the
browser for: listing services, reading deploy status/events, tailing logs, reading/
setting env vars, and triggering deploys.

- **Always read the tool schema first** from
  `~/.cursor/projects/<project>/mcps/user-render/tools/*.json` before calling.
- If the MCP errors (it showed an error at setup), tell the user to check the MCP
  status in Cursor Settings, and fall back to the dashboard/CLI below.

## Browser fallback (dashboard)

When the MCP is down, use the Playwright MCP (`user-playwright`) per the
`browser-control.mdc` rule — never `open` an uncontrollable browser. Navigate to the
service's **Events** page (deploy status), **Logs** page, or **Environment** page.

## Gateway Postgres (`luna-wa-db`)

The gateway's durable capture store. Schema (see `vision/architecture.md`):
`whatsapp_messages` (append-only, source of truth, UNIQUE `wa_msg_id`),
`whatsapp_chats`, `whatsapp_state`.

Connect with psql using the External Connection string from the database's dashboard
page:

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:$PATH"
GW_DB="postgresql://<user>:<pass>@<host>.oregon-postgres.render.com/<db>"
psql "$GW_DB" -c "\dt"
psql "$GW_DB" -c "SELECT count(*), max(ts) FROM whatsapp_messages;"
psql "$GW_DB" -c "SELECT status, connected, self_jid, sent_today FROM whatsapp_state;"
```

**CRITICAL RULES:**
- The capture store is the **source of truth** — treat it as append-only.
- **NEVER** run `DROP`, `TRUNCATE`, or `DELETE` on `whatsapp_messages` without
  explicit user approval and a verified backup.
- Read-only queries (`SELECT`, `\d`, `\dt`) by default; confirm any write first.
- **Never delete the `wa-auth` disk** — separate from the DB, but equally destructive
  (forces a re-scan / relink).

## Related infra context (from luna-service)

- A Render account already exists (luna-service and OSS Luna also deploy there).
- Cloudflare zone `luna.com.ai` exists; a custom domain can be attached to the
  gateway service later.
- OSS Luna's own prod service is `srv-d8cu5hpkh4rs738ao9g0` (`luna-kp8e.onrender.com`)
  — the gateway is a **separate** service, do not conflate them.
- Region convention across these projects: `oregon`.
