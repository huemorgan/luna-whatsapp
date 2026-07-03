# 001 — WhatsApp gateway monitoring support

## Goal

Luna-service is adding a **WhatsApp** page (left pane) that shows the health of
this gateway: online/offline, live connection state, users, message volume.
The gateway must expose everything that page needs from a single endpoint.
See the matching luna-service side: `luna-service/plans/034-whatsapp/recomendation.md`.

## What the gateway exposes

`GET /stats` — admin-key protected (`?key=` or `x-admin-key` header, same
`GATEWAY_ADMIN_KEY` that protects `/qr`). Returns one JSON document:

| Field | Source | Meaning |
|---|---|---|
| `status`, `connected`, `self_jid`, `has_qr`, `last_activity_at` | in-memory socket state (`wa.js`) | Is the Baileys socket open; which number is linked |
| `uptime_s`, `version`, `node`, `rss_mb` | process | Process health |
| `sent_today`, `send_daily_cap` | `whatsapp_state` | Ban-risk budget used vs cap |
| `totals` (`messages`, `chats`, `users`) | `whatsapp_messages` | All-time counts |
| `last_hour` / `last_24h` (`messages_in`, `messages_out`, `active_chats`, `active_users`) | `whatsapp_messages` | Rolling activity windows |
| `media_24h` | `whatsapp_messages.kind` | Non-text kinds breakdown |
| `hourly` (24 buckets, `{hour, in, out}`) | `whatsapp_messages` | Chart data |
| `last_message_at` | `whatsapp_messages` | Freshness |
| `db.ok`, `db.latency_ms` | the query itself | Postgres reachability |

"Live connections" note: Baileys holds exactly **one** upstream socket
(`connected`); what varies is *activity* — hence active chats/users per window.

## Implementation

- `src/db.js` — `getMessageStats()`: three read-only queries (windowed
  aggregates, hourly histogram, media kinds). Indexed by `idx_wa_msg_ts`.
- `src/stats.js` — pure `buildStatsPayload(...)` assembling the JSON
  (unit-testable without Postgres).
- `src/index.js` — the `/stats` route: admin-key check, gather, respond.
  DB failure does not 500 the whole payload — socket state still returns,
  with `db.ok=false` (the page must show "server up, DB down" distinctly).
- `test/gateway.test.mjs` — payload-shape tests over `buildStatsPayload`.

## Deploy

Per `render.yaml` (repo pushed to GitHub → Render blueprint):
`luna-wa-gateway` web service + `luna-wa-db` Postgres. `/stats` ships with the
normal deploy; no new env vars (reuses `GATEWAY_ADMIN_KEY`).

Luna-service connects with two env vars on its side:
`WHATSAPP_GATEWAY_URL` + `WHATSAPP_GATEWAY_ADMIN_KEY` (server-side proxy; the
admin key must never reach the browser).
