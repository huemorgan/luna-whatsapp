# Architecture

How the two ends fit together, what data flows where, and the exact sequences.
Pair this with [`contract.md`](contract.md) (the wire format) and
[`codemap.md`](codemap.md) (file locations).

## Topology

```
┌────────────────────────────────────┐        ┌─────────────────────────────────┐
│  gateway  (Render web svc, 24/7)    │        │  Luna  (your instance)          │
│  Node 20 + Baileys                  │        │  plugin_whatsapp (Python)       │
│                                     │ signed │                                 │
│  • owns the WhatsApp Web socket     │inbound │  routes.py                      │
│  • GET  /qr    (scan page)          │ ─────► │   POST /api/p/plugin-whatsapp/  │
│  • GET  /health                     │  HTTP  │        inbound  (HMAC verify)   │
│  • POST /send   (HMAC verify)       │        │                                 │
│  • POST /react  (HMAC verify)       │ ◄───── │  client.py → gateway /send      │
│  • 100% capture → gateway Postgres  │ signed │  ctx.agent.run_turn(...)        │
│  • reconnect watchdog + auth disk   │  send  │  own tables (context store)     │
└──────────────┬──────────────────────┘        └───────────────┬─────────────────┘
               │                                                │
        gateway Postgres                                 Luna Postgres
        (luna-wa-db: durable                             (plugin-owned tables via
         capture + source of truth)                       ctx.engine — context store)
```

Two independent datastores on purpose:

- **Gateway Postgres (`luna-wa-db`)** — the gateway's own durable capture buffer /
  source of truth. Every message the socket sees lands here first, keyed by
  `wa_msg_id`. Survives Luna being down.
- **Luna Postgres (plugin-owned tables)** — the plugin's context store, written
  from `/inbound` events and from replies it sends. This is what the agent reads to
  build cross-chat context, and it keeps recall/memory local to Luna.

For the single-owner MVP these can even be the same physical Postgres; they are
kept as distinct *logical* stores so Phase 2 (multi-tenant) drops in cleanly.

## Why split into two processes

- **Baileys wants one long-lived socket owner.** If Luna owned it, every Luna
  restart/redeploy (and, in hosted mode, every sleep) would drop the socket and
  lose messages.
- **The gateway needs a persistent disk** (Baileys auth dir) which pins it to a
  single instance — the opposite of how you want a stateless API to scale.
- Isolating the socket means WhatsApp connectivity churns only on *gateway*
  deploys, which are rare, not on every Luna change.

## Inbound sequence (message → reply)

```
1. WhatsApp delivers a message to the Baileys socket (gateway/src/wa.js).
2. Gateway normalizes it and INSERTs into whatsapp_messages (100%, idempotent on
   wa_msg_id) — BEFORE any decision. (db.js)
3. If it is genuinely new inbound (not from_me, not history sync), gateway builds
   the inbound envelope and POSTs it, HMAC-signed, to the plugin's /inbound.
   (inbound.js → contract.md)
4. Plugin verifies the signature, parses the envelope, records the message into its
   own context store. (routes.py + db.py)
5. Plugin runs the ACTIVATION POLICY (policy.py): DM allowlist / group @mention. If
   it declines, it stops here — the message is still stored and will feed context.
6. Plugin builds the CROSS-CHAT CONTEXT window (context.py): union of last 5 min and
   last 30 messages across all chats, attributed.
7. Plugin composes the prompt (persona + context + current message) and calls
   ctx.agent.run_turn(...) headless. (routes.py + luna-integration.md)
8. Plugin takes run_turn's returned text and POSTs it, HMAC-signed, to the gateway's
   /send. (client.py)
9. Gateway sends via Baileys, captures the from_me message too (100%), and returns
   the sent wa_msg_id as the ack. (wa.js)
10. Plugin records the outbound reply into its context store, keyed by that
    wa_msg_id, so future context is complete.
```

Determinism: the reply path sends exactly `run_turn`'s text. The `wa_send` /
`wa_react` tools are intentionally **excluded** from the inbound turn's tool
allowlist so the agent cannot also fire a second send. Those tools remain available
in normal Luna chat for *proactive* sends ("message John on WhatsApp").

## Outbound-only sequence (proactive send from Luna chat)

```
1. In normal Luna chat the agent calls the wa_send tool. (__init__.py handler)
2. client.py signs and POSTs /send to the gateway.
3. Gateway sends via Baileys; captures the from_me message.
(Optionally the plugin can also record it; the gateway capture is the source of
 truth either way.)
```

## Data model

### Gateway store (`gateway/src/db.js`, DB `luna-wa-db`)
- `whatsapp_messages` — append-only, source of truth. Columns: `account`,
  `chat_jid`, `chat_kind` (dm|group), `chat_name`, `sender_jid`, `sender_name`,
  `from_me`, `wa_msg_id` UNIQUE, `reply_to_id`, `ts`, `kind`, `body`, `media_path`,
  `raw` jsonb. Indexes: `(ts desc)`, `(chat_jid, ts desc)`.
- `whatsapp_chats` — one row per chat (jid, kind, name, policy overrides).
- `whatsapp_state` — singleton: link status, self jid, last_seen, watchdog metrics,
  daily send counter.

### Plugin store (`plugin/plugin_whatsapp/db.py`, Luna Postgres via `ctx.engine`)
- `whatsapp_plugin_messages` — the plugin's own isolated table (created with
  `luna_sdk.declarative_base()`, never touching Luna core's Base). Mirrors the
  fields it needs for context: chat/sender/from_me/wa_msg_id/ts/kind/body.
  Idempotent on `wa_msg_id`.

Why the plugin keeps its own copy rather than reading the gateway DB directly:
isolation and portability. The plugin only needs the wire contract + its own Luna
DB; it never needs gateway DB credentials. In Phase 2 this is exactly how per-tenant
isolation is preserved.

## Keepalive & reliability (gateway-owned)

- Always-on Render **web** service = the supervisor (a paid web service does not
  scale-to-zero). No cron health hacks.
- Baileys auth dir on a **persistent disk** (`/data/wa-auth`) so restarts/redeploys
  don't force a re-scan.
- Tuned timings: `keepAliveIntervalMs≈15000`, `connectTimeoutMs≈60000`,
  `defaultQueryTimeoutMs≈60000`.
- **Watchdog**: transport-activity check + an app-silence backstop that forces a
  reconnect on a "zombie" socket (looks open, delivers nothing).
- **Reconnect** on `connection.close` unless `loggedOut`.
- **Send guard**: per-day cap + jitter (ban-risk), sends acked by Baileys outbound
  id.

## Failure modes and how the design absorbs them

| Failure | What happens | Why it's safe |
|---|---|---|
| Luna restarts mid-message | gateway already stored the inbound; forward may fail | message is durable; idempotent on `wa_msg_id`, no dup reply |
| Gateway redeploys | socket drops, reconnects from disk auth; Baileys offline-syncs | no re-scan; capture resumes |
| Duplicate delivery / replay | second INSERT hits `wa_msg_id` UNIQUE → no-op | exactly-once storage |
| Agent produces empty reply | plugin sends nothing | no empty WhatsApp message |
| Bad/again-signed request | HMAC verify fails → 401 | no unsigned action on either end |
