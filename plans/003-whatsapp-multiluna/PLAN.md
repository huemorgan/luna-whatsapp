# 003 — Multi-Luna gateway: one WhatsApp number per Luna instance

**Status:** PLAN
**Driver:** `luna-service/plans/034-whatsapp/multi-luna-gateway-ask.md` (blocking
for their Phase 2 connect flow; their consumer plan is
`luna-service/plans/034-whatsapp/PLAN.md`). This is roadmap Phase 3
(`vision/roadmap.md`) pulled forward, minus sharding (designed for, deferred).

## What changes conceptually

Today the gateway is a personal bridge: ONE Baileys socket, one number, one
shared HMAC secret, inbound hardwired to a single `LUNA_INBOUND_URL`
(`config.js`, `inbound.js`). After this plan it is a **connector service**:

- **N accounts**, each = one WhatsApp number = one Luna instance = one Baileys
  session, own auth dir, own QR lifecycle, own HMAC secret, own daily cap.
- **Routing lives in Postgres** (`whatsapp_accounts`), not env. Adding a Luna
  is an API call — no env edit, no redeploy.
- **Admin API** (`/accounts…`, admin-key gated) drives the whole lifecycle;
  luna-service's control plane is the caller.
- The currently linked number keeps working untouched as account **`default`**
  (zero-downtime migration; legacy env vars remain as seed/fallback).

## Security model (the invariant everything hangs on)

| Credential | Holder | Grants |
|---|---|---|
| per-account `secret` | that tenant's Luna (vault `plugin_whatsapp.shared_secret`) | send/react **through that account's number only**; verifies inbound *from* the gateway |
| `GATEWAY_ADMIN_KEY` | luna-service control plane (and Roy) | account lifecycle, all QR pages (= number takeover), `/stats` |
| `WA_SHARED_SECRET` (env, legacy) | Roy's single Luna | alias for account `default`'s secret during migration |

A compromised tenant secret must not: send via another number, read another
account's QR, or enumerate accounts. Admin responses never echo secrets except
`POST /accounts` (create) and `PATCH` with `rotate_secret`.

---

## Part A — Gateway (Render service)

### A1. Schema v2 (`src/db.js`)

New registry table (also the future sharding hook — `gateway_id` exists from
day one, constant `'gw-1'` until we shard):

```sql
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  account_id   text PRIMARY KEY,          -- luna-service passes agent slug
  secret       text NOT NULL,             -- 32-byte hex, HMAC key for this account
  inbound_url  text,                      -- https://<that-luna>/api/p/plugin-whatsapp/inbound
  gateway_id   text NOT NULL DEFAULT 'gw-1',
  status       text NOT NULL DEFAULT 'created',  -- created|linking|open|disconnected|logged_out|disabled
  self_jid     text,
  last_seen    timestamptz,
  sent_today   int NOT NULL DEFAULT 0,
  sent_day     date,
  daily_cap    int,                       -- NULL → config.sendDailyCap
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

Changes to existing tables:
- `whatsapp_chats`: add `account` column (default `'default'`), PK becomes
  `(account, chat_jid)` — migration: `ALTER TABLE … DROP CONSTRAINT
  whatsapp_chats_pkey, ADD PRIMARY KEY (account, chat_jid)`.
- `whatsapp_messages`: `account` column already exists; add index
  `(account, ts DESC)`.
- `whatsapp_state`: **deprecated**. One-time migration copies its row into
  `whatsapp_accounts('default')`; table left in place (harmless) but no longer
  read or written.

Boot migration (`migrateToAccounts()`, idempotent, runs in `initSchema()`):
1. If `whatsapp_accounts` has no `default` row AND legacy env
   `WA_SHARED_SECRET` is set → insert `default` with `secret =
   WA_SHARED_SECRET`, `inbound_url = LUNA_INBOUND_URL`, and
   status/self_jid/sent_today copied from `whatsapp_state`.
2. Auth-dir move: if `<WA_AUTH_DIR>/creds.json` exists (flat layout) and
   `<WA_AUTH_DIR>/default/` doesn't → `mkdir default` and move every file
   into it. Baileys `useMultiFileAuthState` then loads it unchanged — **the
   linked number survives with no re-scan**.

Secrets sit plaintext in Postgres (the gateway must sign with them, so at
best we could envelope-encrypt with a master-key env). Deferred to a
hardening pass; noted in Open items.

### A2. Session refactor (`src/wa.js` → `src/session.js` + `src/accounts.js`)

`wa.js`'s module-level singletons (`sock`, `status`, `selfJid`, `currentQr`,
`lastActivityAt`, `reconnecting`, `groupNameCache`, `watchdogTimer`) become a
**`Session` class** — one instance per account, each owning:

- its Baileys socket + `authDir = <WA_AUTH_DIR>/<account_id>/`
- its QR/link lifecycle + status writes to **its** `whatsapp_accounts` row
- its reconnect loop + watchdog (the current global `if (watchdogTimer)
  return` guard would silently disable watchdogs for sessions 2..N — the
  class scope fixes that bug by construction)
- its group-name cache, `markActivity`, presence/`withComposing`
- `sendText/sendMedia/react` with **its own** `bumpSendCounter(account)`
  against `daily_cap ?? config.sendDailyCap`
- inbound: `handleMessage`/`handleReaction` write rows with
  `account = this.accountId` and forward via `forwardInbound(envelope,
  {url: this.inboundUrl, secret: this.secret})` (`inbound.js` gains the
  route parameter; envelope keeps its `account` field so the plugin can see it)

`src/accounts.js` — the registry:
- `loadAll()` at boot: start a `Session` per enabled account row. Sessions
  with no creds yet sit in `linking` and keep a QR fresh (same behavior the
  single session has today).
- `create({account_id, inbound_url, daily_cap})` — validate id
  (`^[a-z0-9][a-z0-9._-]{0,63}$`), generate 32-byte-hex secret, insert row,
  start session. Idempotent: existing row → update `inbound_url` if given,
  return stored secret.
- `update(id, {inbound_url, daily_cap, rotate_secret})` — rotation generates
  a new secret and returns it once.
- `remove(id)` — `sock.logout()` best-effort, stop session, `rm -rf` its auth
  dir, mark row `enabled=false, status='disabled'` (messages are never
  deleted — capture history stays).
- Pure helpers (`chatKind`, `extractContent`, `parseReaction`,
  `buildMediaContent`, `toMediaUpload`, …) move out as module functions and
  keep their current unit tests (imports updated).

### A3. Request → account resolution (`/send`, `/send-media`, `/react`)

Body/shape unchanged (plugin compatibility). Resolution order:

1. `x-wa-account: <id>` header present → verify HMAC against **that**
   account's secret only. 401 on mismatch.
2. No header → try each enabled account's secret (constant-time compare per
   candidate; N is small). First match wins. This keeps **plugin v0.5.0
   working unmodified** — each Luna already signs with its own (vault)
   secret, which now maps to exactly one account.
3. No match → legacy env `WA_SHARED_SECRET` → account `default` (covers the
   window where the default row was seeded with a rotated secret).

The resolved account's session does the send; its cap applies; the send is
captured with its `account`.

### A4. Admin API (all `x-admin-key` / `?key=` gated, JSON)

| Route | Behavior |
|---|---|
| `POST /accounts` | `{account_id, inbound_url, daily_cap?}` → create/start; **returns `{account_id, secret, status, qr_url}`**. Idempotent. |
| `GET /accounts` | list: `account_id, status, connected, self_jid, has_qr, inbound_host, sent_today, daily_cap, last_seen, enabled` — **no secrets, no full inbound_url** (host only, matching what /stats exposes). |
| `GET /accounts/{id}` | same shape, single. |
| `GET /accounts/{id}/qr` | `?format=html` (default; the existing dark-card page, per-account) / `json` (`{qr, status, connected, self_jid}`) / `png`. |
| `PATCH /accounts/{id}` | `{inbound_url?, daily_cap?, rotate_secret?}`; returns `{…, secret}` only when rotated. Machine moved ⇒ control plane PATCHes the new URL — takes effect immediately (session reads registry row, no restart). |
| `DELETE /accounts/{id}` | logout + stop + wipe auth dir + disable. |

Back-compat: `/qr` (existing admin page) becomes an alias for
`/accounts/default/qr?format=html`. `/health` stays public and global
(overall service liveness + per-gateway summary counts, no per-account detail).

### A5. `/stats` per-account breakdown

Existing global payload (luna-service Phase-1 page already consumes it —
**do not change existing keys**) plus:

```json
"accounts": [{
  "account_id": "default", "status": "open", "connected": true,
  "self_jid": "9725…@s.whatsapp.net", "has_qr": false,
  "inbound_host": "luna-kp8e.onrender.com",
  "messages_24h_in": 140, "messages_24h_out": 120,
  "sent_today": 12, "daily_cap": 300, "last_seen": "…"
}]
```

One grouped query (`GROUP BY account` over the 24h window) joined with the
registry + live session states. `stats.js` `buildStatsPayload` gains the
`accounts` input; stays pure/unit-tested.

### A6. Capacity honesty (required by the ask)

A Baileys socket holds the noise/signal state, key store, and event buffers:
**~60–120 MB RSS each** in practice (plus spikes while syncing). The Render
**starter (512 MB)** instance realistically holds **3–5 concurrent linked
sessions** with headroom for media sends; **standard (2 GB)** ≈ 15–20.
Plan: stay on starter until 3 accounts, then bump the plan (env-free change).
Sharding story (deferred, designed-for): `whatsapp_accounts.gateway_id` +
`GATEWAY_ID` env per instance; each instance `loadAll()`s only its own rows;
the control plane assigns `gateway_id` at `POST /accounts` time and routes
admin calls to the right instance. No code today assumes a single row-set
beyond `WHERE gateway_id = $me`, so adding instance #2 is registry data.
Also honest: Render `starter` disk is 1 GB — each auth dir is ~1–5 MB, a
non-issue; RAM is the binding constraint.

### A7. Rollout (each step deployable, `default` keeps working)

1. **Schema + migration + registry seeding** — no behavior change; verify
   `default` row materializes with correct secret/status, flat auth dir moved.
2. **Session class refactor** — still exactly one session (`default`),
   behavior-identical; tests moved; deploy; confirm the linked number still
   sends/receives (or still shows its QR if not yet linked).
3. **Multi-secret resolution + per-account inbound routing** — env fallback
   intact; plugin v0.5.0 unaffected.
4. **Admin API + per-account QR + `/stats.accounts`** — new surface only.
5. **Acceptance** (the ask's bar): create a second account via `POST
   /accounts`, link a second number via its own QR, prove: inbound for #2
   reaches only #2's `inbound_url`, signed with #2's secret; #2's secret
   cannot send through `default`'s number (401); per-account caps tick
   independently; `DELETE` cleans up; `default` untouched throughout.
6. Update `vision/` docs (architecture/codemap/roadmap Phase-3 status) and
   answer the ask in `luna-service/plans/034-whatsapp/` (gateway-reply doc).

Failure rollback: steps 1–2 are additive; a revert redeploys the old image
whose flat-auth-dir expectation is the only casualty — the migration's move
is one-way, so the rollback path is `WA_AUTH_DIR=/data/wa-auth/default`. Note
it in the deploy notes.

---

## Part B — Plugin (`plugin-whatsapp`)

The plugin is **already per-Luna** (own gateway URL + own secret, vault-first
via `plugin_whatsapp.shared_secret` — `client.py`). With gateway-side
secret→account resolution it works **unmodified**. Still worth a **v0.6.0**:

1. **Fix version drift** (flagged by luna-service): `pyproject.toml` says
   `0.4.0` while `luna-plugin.toml` says `0.5.0`. Align both at `0.6.0`.
2. **Send `x-wa-account` when configured**: new optional env/vault key
   `LUNA_WHATSAPP_ACCOUNT_ID` (luna-service will inject agent slug). When
   set, `client.py` adds the header to `/send`, `/send-media`, `/react` —
   O(1) account resolution and a hard bind of this Luna to its account (a
   mis-pasted foreign secret then 401s instead of silently sending through
   the wrong number).
3. **Settings/status honesty**: `wa_status` + settings tab currently read
   global `/health`; when `LUNA_WHATSAPP_ACCOUNT_ID` is set and the admin key
   is absent (hosted tenants never get it), show "managed by your host"
   instead of a dead QR link. Self-hosted single-Luna flow (env secret +
   admin key + `/qr`) unchanged.
4. Publish v0.6.0 to marketplaces.com.ai official (same upload path as
   0.5.0); luna-service's catalog entry pins `>=0.6.0`.

No changes to the inbound verification path (per-account secret arrives the
same way), policy, context, or media code.

---

## Test plan

- **Unit (gateway, `node --test`, no socket/PG):** account-id validation;
  secret resolution matrix (header hit/miss, scan hit, legacy fallback, no
  match); `buildStatsPayload` with `accounts`; existing hmac/media/reaction
  tests keep passing after the module split; Session state transitions with a
  stubbed socket factory (open→disconnected→reconnect, logged_out does NOT
  reconnect, watchdog per-instance).
- **DB-integration (against local PG, existing `tools/db_helper.mjs`
  pattern):** migration idempotence (run `initSchema` twice), `whatsapp_state`
  → `default` copy, chats PK migration with data present, per-account
  `bumpSendCounter` rollover + isolation.
- **Plugin (`pytest`):** header present iff account id configured; version
  alignment check; status-tab branch.
- **Dojo:** existing conversations must pass against the refactored gateway
  (they exercise the `default` path); add `15-second-account.md` simulating a
  second account's inbound envelope.
- **Live acceptance:** the two-number test in A7-5, driven via curl against
  the deployed service.

## Open items / deferred

- **Secret-at-rest encryption** in `whatsapp_accounts` (master-key env) — after.
- **QR idle policy**: an unlinked session regenerates QR forever (Baileys 408
  loop, visible in logs today). Acceptable at N≤5; consider pause-after-30min
  + resume-on-QR-request when account counts grow.
- **Sharding activation** (`gateway_id` #2) — registry is ready; control-plane
  assignment logic is luna-service work when capacity demands it.
- **Relay/queue inbound** (roadmap's Standard-Webhooks + wake-sleeping-machine
  forwarder): NOT in this plan — direct signed POST per account is what the
  ask specifies; the queue belongs to luna-service's relay if/when Fly
  machines sleep. Flagged in the reply doc so they own the wake problem.
- Multi-instance Postgres advisory lock (two gateways must never both own an
  account) — comes with sharding.
