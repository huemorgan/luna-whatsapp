# 006 — Anti-ban send discipline: outbox queue, pacing, circuit breaker, IP hygiene

**Status:** PLAN
**Driver:** Two WhatsApp-initiated device removals in 2 days (2026-07-10 19:57,
2026-07-11 14:59 UTC — `stream:error 401 conflict device_removed`, preceded by
`error 463: account restricted or missing tctoken for contact`). Trigger: a
batch of 6 similar cold DMs sent back-to-back (current jitter is only
0.3–1.0s, `session.js` sendText). The next enforcement step after repeated
device removals is a permanent number ban.

## Principles (what the design encodes)

1. **A burst must be impossible.** No caller — agent, plugin bug, retry loop —
   can make the gateway emit two messages close together. Pacing is enforced
   at the gateway, per account, in one place.
2. **Cold contacts are the danger.** A JID that never messaged us has no
   tctoken; sends to it are the enforcement trigger. They get long gaps and a
   small daily budget.
3. **When WhatsApp pushes back, we stop.** Restriction signals trip a circuit
   breaker; we never "retry through" enforcement.
4. **Fresh links are on probation.** After a QR relink, the account runs in
   warm-up mode with tighter limits.
5. **Accounts must not share fate.** One egress IP per few accounts, distinct
   fingerprints, staggered connects (Part E).

---

## Part A — Persistent outbox queue (gateway)

### A1. Schema v3 (`src/db.js`)

```sql
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  text NOT NULL,
  chat_jid    text NOT NULL,
  kind        text NOT NULL,             -- text | media | react
  payload     jsonb NOT NULL,            -- full request body (text/reply_to or media opts)
  class       text NOT NULL,             -- conversational | warm | cold  (A3)
  status      text NOT NULL DEFAULT 'queued', -- queued | sending | sent | failed | canceled | held
  not_before  timestamptz NOT NULL DEFAULT now(),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  wa_msg_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_drain ON whatsapp_outbox (account_id, status, not_before);
```

`whatsapp_accounts` gains: `breaker_until timestamptz`, `breaker_reason text`,
`linked_at timestamptz` (set on every successful pairing → drives warm-up),
`proxy_url text` (Part E).

Queue survives Render deploys/restarts by construction; on boot each account
worker resumes draining `queued` rows in `not_before` order.

### A2. Enqueue instead of send

`/send`, `/send-media`, `/react` (in `index.js`) stop calling
`session.sendText/sendMedia/react` directly. Flow:

1. Resolve JID (unchanged).
2. Classify (A3), compute `not_before` = last-send-time + gap(class) (A4).
3. Insert outbox row.
4. **Sync fast-path:** if the wait is ≤ `WA_SYNC_WAIT_MS` (default 10 000) and
   the queue ahead is empty, hold the HTTP request, deliver, return today's
   response shape (`{ok, chat_jid, wa_msg_id}`) — single conversational sends
   keep their exact current UX.
5. Otherwise return `202 {ok: true, queued: true, send_id, eta_seconds,
   position}`.

New endpoints (HMAC, per-account):
- `POST /outbox/status {send_id}` → row status (+`wa_msg_id`/`last_error`).
- `POST /outbox/list {}` → pending rows for the account.
- `POST /outbox/cancel {send_id}` → cancel if still `queued`.

### A3. Recipient classes

Computed at enqueue from `whatsapp_messages` (already 100%-capture):

| class | definition | why |
|---|---|---|
| `conversational` | inbound from this chat within the last 15 min | replying in an active chat — safest send there is |
| `warm` | any inbound ever from this JID (or any group we're in) | tctoken exists |
| `cold` | zero inbound ever from this JID | the 463 trigger |

### A4. Pacing rules (per account, env-tunable, all randomized)

| class | gap between sends | extra budget |
|---|---|---|
| `conversational` | 1.5–4 s | — |
| `warm` | 8–25 s | — |
| `cold` | 90–240 s | `WA_COLD_DAILY_CAP` = **6**/day, max 2/hour |

- One serialized drain worker per account — cross-class ordering preserved,
  gaps enforced between *any* two sends, whatever their class.
- **Same-text burst guard:** identical (normalized) text to ≥3 distinct chats
  within 10 min → remaining ones are re-classed `cold` (pacing + budget) and a
  warning is logged. This is the exact signature that got us restricted.
- Existing daily cap (`WA_SEND_DAILY_CAP` 300) and 0.3–1 s jitter stay as the
  inner guard; `bumpSendCounter` moves to the drain worker so a queued-then-
  canceled message never consumes cap.

### A5. Failure handling in the worker

- Transient send error → `attempts+1`, backoff `not_before += 30s * attempts`,
  max 3 attempts → `failed`.
- Socket not open → row stays `queued`; worker parks until `connection: open`.
- Restriction signal → Part B (breaker), row goes `held`, **no retry**.

---

## Part B — Circuit breaker + warm-up

### B1. Trip conditions (watched in `session.js`)

- Send ack / message with `error 463` ("account restricted", "tctoken").
- `stream:error` with `conflict` (`device_removed`, `replaced`).
- `connection close` code 401/403.

### B2. Behavior on trip

- All `queued` rows for the account → `held`; `breaker_until = now() +
  WA_BREAKER_HOURS` (default **6 h** full freeze), `breaker_reason` recorded.
- Cold sends stay blocked for `WA_COLD_FREEZE_HOURS` (default **48 h**) after
  the trip, even once the general breaker clears.
- While tripped: enqueue attempts return `503 {code: 'breaker_open',
  reason, until}` — the agent gets an honest, non-retryable answer.
- Manual override: `POST /outbox/release {}` (admin key) un-holds after a
  human decision. `held` rows re-queue with fresh pacing; they never auto-fire
  the moment the breaker clears.

### B3. Warm-up after relink

For `WA_WARMUP_HOURS` (default **72 h**) after `linked_at`:
daily cap halved, cold cap = **2**/day, all gaps doubled. A relink immediately
followed by a batch is exactly what happened on 07-11 — warm-up makes it
structurally impossible.

### B4. Surfacing

- `/health` + `/stats` gain `queue_depth`, `breaker` (reason/until),
  `warmup_until`, `cold_sent_today`.
- Optional (stretch): gateway POSTs a `kind: "system"` envelope to the
  account's inbound URL on breaker trip so Luna can proactively tell Roy.

---

## Part C — Plugin 0.11.0

- `client.send_message/send_media/react`: handle `202 queued` (return
  `{queued, send_id, eta_seconds}`) and `503 breaker_open` (raise with the
  reason so the agent relays it and does NOT retry).
- `wa_send` tool result for queued sends: "queued — the gateway paces
  outbound to protect the account; delivery in ~N min. Do not resend."
- `wa_status` shows breaker / warm-up / queue depth.
- New skill-gated tool `wa_outbox` (in the `whatsapp` skill): list + cancel
  pending sends.
- Skill/PERSONA text: batches are fine to hand over all at once — the gateway
  spaces them out; never call wa_send twice for the same message; cold
  first-contacts are budgeted (~6/day) and may be refused.
- Tests: 202/503 handling, wa_outbox, prompt-copy assertions.

---

## Part D — Contract & docs

- `vision/contract.md`: `202` semantics for the three send endpoints, the
  three `/outbox/*` endpoints, `breaker_open` error, new `/health` fields.
- Update `/status` UI text in the plugin settings page (queue/breaker states).

---

## Part E — Multi-account IP & fingerprint hygiene (future-proofing)

Problem: many Baileys sessions from one datacenter IP correlate; one flagged
account can taint the rest, and the IP itself accumulates reputation.

1. **Per-account egress proxy.** `whatsapp_accounts.proxy_url` (socks5/https).
   `makeWASocket` accepts an `agent` — build one per session from `proxy_url`
   (sticky **residential/mobile** proxies, one per account; datacenter IPs are
   the worst class). No proxy set → direct (today's behavior).
2. **Accounts-per-IP budget:** soft rule ≤ 3 accounts per egress IP; enforce
   with a startup warning in `accounts.js` when exceeded.
3. **Distinct fingerprints:** per-account `browser` tuple (e.g. rotate
   `Browsers.macOS/ubuntu/windows(name)`) instead of one global value.
4. **Staggered connects:** on boot, start sessions 15–45 s apart (randomized)
   instead of simultaneously; same for mass reconnects after a network blip.
5. **Sharding** stays the escape hatch: `gateway_id` exists since plan 003 —
   more accounts → more gateway instances, each with its own IP pool.

## Part F — What we do NOT build (policy reality)

- **Cold outreach at scale** has no safe unofficial form. The sanctioned path
  is the WhatsApp Business Platform (Cloud API): paid, template-approved,
  no ban risk — but numbers there **cannot join or act in user groups like a
  regular member** (group support is business-created groups only, and
  limited). If a "joins groups, behaves like a person" number is a hard
  requirement, the unofficial client + the discipline in this plan is the only
  route, and residual ban risk stays.
- Paid unofficial providers (Whapi, Green-API, Wassenger…) run the same
  Baileys-class approach with managed IP pools — same ToS exposure, less
  control. Not adopted.
- Baileys 7.0.0-rc13 is current (checked 2026-07-11, both npm names). Watch
  item: adopt the stable 7.0.0 when released — rc tctoken handling is a known
  churn area.

## Tests (dojo suite, `WA_DRY_SEND` + fake timers)

- Ordering: N enqueues drain serially with gaps in the class's range; no two
  sends closer than the class minimum, ever (property-style assertion).
- Classification: conversational / warm / cold derived correctly from seeded
  `whatsapp_messages`; group JIDs are warm.
- Same-text burst → re-class to cold + budget consumed.
- Cold budget: 7th cold send of the day → refused with explanatory error.
- Sync fast-path: empty queue + short gap → old response shape; busy queue →
  202 with sane eta.
- Breaker: fake 463 / device_removed trips it; enqueue → 503; `held` rows
  don't fire after expiry without release; release re-queues with pacing.
- Warm-up: fresh `linked_at` → halved caps/doubled gaps.
- Persistence: kill worker mid-queue, reboot → drain resumes, no dupes
  (idempotent on outbox id).
- Cancel: only `queued` rows cancelable; canceled rows don't consume cap.

## Rollout

1. Schema v3 migration (idempotent `CREATE TABLE/ALTER … IF NOT EXISTS`).
2. Gateway behind env flag `WA_OUTBOX=1` for one deploy (fallback: direct
   send), then default-on and flag removed.
3. Plugin 0.11.0 published; gateway deployed (manual deploy trigger —
   auto-deploy is off).
4. Contract doc + execution summary.

**Out of scope:** official Cloud API integration; proxy procurement
(infrastructure decision — plan supports it via `proxy_url` when bought).
