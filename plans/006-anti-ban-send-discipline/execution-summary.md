# 006 execution summary — anti-ban send discipline

Executed 2026-07-11. Gateway + plugin shipped together (plugin v0.11.0).

## What was built

### Part A — persistent outbox (gateway)
- Schema v3: `whatsapp_outbox` table (uuid `id`, `account_id`, `chat_jid`,
  `kind` text|media|react, `payload` jsonb, `class`, `status`
  queued|sending|sent|failed|canceled|held, `not_before`, `attempts`,
  `last_error`, `wa_msg_id`, timestamps) + drain index; `whatsapp_accounts`
  gained `breaker_until`, `breaker_reason`, `linked_at`, `proxy_url`.
- `src/outbox.js`: `classify` (conversational ≤15 min inbound / warm any
  inbound / cold never), `gapMsFor` (1.5–4 s / 8–25 s / 90–240 s, doubled in
  warm-up), `SameTextGuard` (same normalized text to ≥3 chats in 10 min →
  cold), `estimateWaitMs`, `OutboxWorker` (one serial drain loop per account,
  injectable store, `waitForSettle` for the sync fast-path).
- `pgOutboxStore` in `src/db.js`; the queued→sending claim is guarded
  (`AND status='queued'`) so cancel is race-free.
- Endpoints: `/send`, `/send-media`, `/react` enqueue (200 sync if eta ≤10 s,
  else 202 `{queued, send_id, class, eta_seconds}`); `/outbox/status|list|cancel`
  (HMAC); admin `/accounts/:id/outbox/release`.
- Cold budget: 6/day, 2/hour (2/day in warm-up) → 429 `cold_budget`.

### Part B — circuit breaker + warm-up
- Per-session pino `hooks.logMethod` + `detectRestrictionSignal` catches
  `error 463 / account restricted / missing tctoken / device_removed` (no
  Baileys event exists for these); 401/403 connection close also trips.
- Trip → outbound frozen 6 h, cold frozen 48 h, queued rows parked `held`,
  persisted to the row; nothing auto-fires — manual release only.
- Fresh QR link → 72 h warm-up: halved daily cap, doubled gaps, cold cap 2/day.

### Part C/D — plugin 0.11.0 + contract
- Client handles 202 as success; `wa_send`/`wa_send_media` annotate queued
  results ("Do NOT re-send"); new `wa_outbox` tool (list/status/cancel) in the
  `whatsapp` skill (15 tools); skill + capability prompts teach the pacing
  semantics. `vision/contract.md` updated (202/429/503, classes, outbox API).

### Part E — IP hygiene (cheap wins)
- Per-account browser fingerprint (`pickBrowser`, deterministic; `default`
  keeps the legacy tuple so the linked number sees no device change).
- Staggered account connects on boot (15–45 s apart); gateway now listens
  BEFORE loading accounts so Render health checks don't wait.
- `proxy_url` column → per-account socks/https egress agent
  (`socks-proxy-agent`/`https-proxy-agent`, graceful fallback to direct).

### Part F — not built (policy reality)
No official product lets a number join user groups like a person; WhatsApp
Business Cloud API is the only ban-proof paid path (business-initiated,
business-created groups only). Unofficial paid providers carry the same ToS
risk as Baileys. Baileys 7.0.0-rc13 is current on npm; watch for stable 7.0.0.

## Tests
- Gateway: 74 passing (`node --test`) — pacing, classes, burst guard,
  breaker/warm-up, worker drain/retry/hold/cancel/recover with an in-memory
  store double.
- Plugin: 113 passing (pytest) — incl. wa_outbox actions and queued-send
  annotation.

## Rollout
- `WA_OUTBOX=1` default; `WA_OUTBOX=0` restores the direct path.
- Schema v3 applies idempotently on boot (`initSchema`).
- Env knobs: `WA_GAP_CONVERSATIONAL_MS`, `WA_GAP_WARM_MS`, `WA_GAP_COLD_MS`,
  `WA_COLD_DAILY_CAP`, `WA_COLD_HOURLY_CAP`, `WA_SYNC_WAIT_MS`,
  `WA_BREAKER_HOURS`, `WA_COLD_FREEZE_HOURS`, `WA_WARMUP_HOURS`.
