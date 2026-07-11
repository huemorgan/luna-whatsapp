# The wire contract (gateway ↔ plugin)

> This is the single boundary between the two ends. **Every field here is
> implemented twice** — once in `gateway/` (Node) and once in
> `plugin/plugin_whatsapp/` (Python). If you change anything on this page, you
> change BOTH sides in the same commit, or the link breaks silently (401s or
> dropped messages).

## Authentication — HMAC (both directions)

Identical scheme in `gateway/src/hmac.js` and `plugin/plugin_whatsapp/hmac.py`.

- **Signature** = `hex( HMAC_SHA256( secret, f"{timestamp}.{rawBody}" ) )`
  where `rawBody` is the **exact bytes** of the JSON request body (no
  re-serialization on the verify side — read the raw body and verify against it).
- **Headers** sent with every signed request:
  - `x-wa-timestamp` — unix seconds when signed
  - `x-wa-signature` — the hex digest
- **Verification** rejects if either header is missing, if the timestamp skew is
  `> 300s`, or if the digest doesn't match (constant-time compare).
- The **shared secret** is `WA_SHARED_SECRET` on the gateway and
  `LUNA_WHATSAPP_SHARED_SECRET` (or vault key `plugin_whatsapp.shared_secret`) on
  the plugin. They MUST be byte-identical. Verified cross-language:
  `sign("shared", '{"x":1}', "1000")` → `496dee52…48948` on both Node and Python.

Common bug: if you ever `JSON.stringify` / `json.dumps` the body again before
verifying (instead of using the raw received bytes), key order/whitespace can
differ and every signature will fail. Always verify against the raw body.

## Endpoints

### Gateway (called by the plugin)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/health` | none | – | `{status, connected, self_jid, has_qr, last_activity_at, sent_today, queue_depth, breaker, warmup_until}` |
| GET | `/qr?key=<GATEWAY_ADMIN_KEY>` | admin key | – | HTML QR page (auto-refreshes; shows "linked" once connected) |
| POST | `/send` | HMAC | `{chat_jid, text, reply_to?}` | 200 `{ok, chat_jid, wa_msg_id}` or 202 queued (below) |
| POST | `/send-media` | HMAC | `{chat_jid, kind, url?\|data_base64?, caption?, mimetype?, file_name?, reply_to?, gif_playback?, ptt?, ptv?}` | 200 `{ok, chat_jid, wa_msg_id}` or 202 queued |
| POST | `/react` | HMAC | `{chat_jid, wa_msg_id, emoji}` | 200 `{ok}` or 202 queued |
| POST | `/outbox/status` | HMAC | `{send_id}` | `{ok, send_id, chat_jid, kind, class, status, attempts, wa_msg_id, last_error, not_before, created_at}` |
| POST | `/outbox/list` | HMAC | `{}` | `{ok, pending: [row…], breaker: {reason, until} \| null}` |
| POST | `/outbox/cancel` | HMAC | `{send_id}` | `{ok, …row}` — 409 if already sending/sent |
| POST | `/resolve` | HMAC | `{target}` | `{ok, jid, kind}` — 400 invalid, 404 `not_on_whatsapp` |
| POST | `/groups/list` | HMAC | `{}` | `{ok, groups: [{jid, subject, participants_count, owner, announce}]}` |
| POST | `/groups/info` | HMAC | `{group_jid}` | `{ok, group: {jid, subject, description, owner, created_at, announce, participants_count, participants: [{jid, admin}], me_admin}}` |
| POST | `/groups/subject` | HMAC | `{group_jid, subject}` | `{ok}` |
| POST | `/groups/participants` | HMAC | `{group_jid, action: add\|remove\|promote\|demote, participants: [target…]}` | `{ok, results: [{jid, status}]}` ('200' ok, '403' not allowed, '408' recently left) |
| POST | `/groups/create` | HMAC | `{subject, participants?}` | `{ok, group}` (same shape as `/groups/info`) |
| POST | `/groups/leave` | HMAC | `{group_jid}` | `{ok}` |
| POST | `/groups/invite` | HMAC | `{group_jid}` | `{ok, code, url}` |

**Target resolution** (`/send`, `/send-media`, `/react` `chat_jid`; `/resolve`
`target`; every `participants` entry): the gateway accepts a full JID
(`…@g.us`/`…@lid`/… pass through; phone JIDs are canonicalized — device suffix
stripped), or a phone number in any human format (digits are extracted and
verified with `onWhatsApp`; unregistered numbers → 404 `not_on_whatsapp`).
Success responses echo the canonical `chat_jid` actually used. Group endpoints
require a literal `…@g.us` JID.

### Plugin (called by the gateway)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/api/p/plugin-whatsapp/inbound` | HMAC | inbound envelope (below) | `{ok, answered, reason?}` |
| GET | `/api/p/plugin-whatsapp/status` | Luna user | – | `{gateway: <health or null>}` |
| GET | `/api/p/plugin-whatsapp/qr` | Luna user | – | proxies gateway `/qr` (needs `LUNA_WHATSAPP_GATEWAY_ADMIN_KEY`) |
| GET | `/api/p/plugin-whatsapp/ui/settings/` | Luna user | – | settings HTML (status + link button) |

## The inbound envelope (gateway → plugin `/inbound`)

Produced in `gateway/src/wa.js` (`forwardInbound` payload), consumed in
`plugin/plugin_whatsapp/routes.py` (`inbound`). Shape:

```json
{
  "account":       "default",
  "chat_jid":      "123456@s.whatsapp.net" | "123-456@g.us",
  "chat_kind":     "dm" | "group",
  "chat_name":     "Group name or contact label, or null",
  "sender_jid":    "123456@s.whatsapp.net",
  "sender_name":   "pushName or null",
  "wa_msg_id":     "3EB0...",
  "reply_to_id":   "wa_msg_id being replied to, or null",
  "ts":            "2026-07-01T09:00:00.000Z",   // ISO 8601, UTC
  "kind":          "text|image|audio|video|doc|sticker|contact|location|reaction|other",
  "body":          "message text / caption / '' ",
  "mentioned_me":  true,   // gateway computed: was the linked number @mentioned?
  "is_reply_to_me":false   // gateway computed: is this a reply to the bot?
}
```

### Reaction events (`kind == "reaction"`)

When someone reacts (a "like"/emoji) to a message **Luna herself sent**, the
gateway (`wa.js::parseReaction`) forwards a reaction envelope. It reuses the
fields above (`sender_jid`/`sender_name` = the reactor; `chat_*` = the chat) and
adds:

```json
{
  "kind":                    "reaction",
  "body":                    null,
  "reaction_emoji":          "❤️",           // the emoji tapped ('' removal is dropped, never sent)
  "reaction_target_id":      "wa_msg_id of the message that was reacted to",
  "reaction_target_from_me": true,           // always true — only likes on OUR messages are forwarded
  "reply_to_id":             "= reaction_target_id",
  "is_reply_to_me":          true,           // a like on our msg counts as addressing us
  "wa_msg_id":               "reaction event id (idempotency key)"
}
```

Gateway guarantees for reactions:
- Only reactions **to our own messages** are forwarded (`target.fromMe`), never
  reactions to other people's messages, our own reactions, or removals.
- The plugin records it as context (`kind="reaction"`, body `"reacted <emoji> to
  your message"`) and may reply, but usually stays silent — a like rarely needs a
  reply (see `_build_reaction_prompt`).

Rules the gateway guarantees:
- Only **genuinely new inbound** is forwarded: `from_me == false` and Baileys
  `type == 'notify'` (history sync `append` is captured but NOT forwarded).
- `mentioned_me` / `is_reply_to_me` are computed on the gateway (it knows the self
  jid), so the plugin's group-activation policy needs only these booleans.
- `status@broadcast` is dropped entirely.

Rules the plugin relies on:
- `chat_kind` drives activation (`policy.py`).
- `mentioned_me || is_reply_to_me` triggers a group reply.
- `wa_msg_id` is the idempotency key everywhere.
- `ts` is parsed as ISO (Z → +00:00).

## Outbound send (plugin → gateway `/send`)

`plugin/plugin_whatsapp/client.py::send_message` → `gateway/src/index.js` `/send`
→ the per-account **outbox** (006 anti-ban send discipline) → `session.js`.

Every send is enqueued in `whatsapp_outbox` and drained serially with a
randomized human-pacing gap by recipient class:

| class | meaning | gap between sends |
|---|---|---|
| `conversational` | that chat wrote to us in the last 15 min | 1.5–4 s |
| `warm` | that chat has written to us at some point | 8–25 s |
| `cold` | first-ever outbound to this chat (the 463 enforcement trigger) | 90–240 s + budget (6/day, 2/hour) |

Same normalized text to ≥3 distinct chats in 10 min is re-classed `cold`.

**Response semantics (all three send endpoints):**

```json
// 200 — delivered synchronously (estimated wait ≤ ~10 s and it settled in time)
{ "ok": true, "account": "…", "chat_jid": "…", "wa_msg_id": "3EB0…" }
// 202 — accepted and queued; WILL be delivered. NEVER retry a 202.
{ "ok": true, "queued": true, "send_id": "<uuid>", "class": "warm",
  "eta_seconds": 42, "account": "…", "chat_jid": "…" }
// 429 — cold first-contact budget exhausted (code: "cold_budget"). Not retryable today.
// 503 — circuit breaker open after a WhatsApp restriction signal
//       (code: "breaker_open" | "cold_frozen", until: ISO). Do not retry;
//       held sends fire only after an admin releases the breaker.
{ "ok": false, "code": "breaker_open", "error": "…", "until": "2026-…" }
```

The breaker trips on `error 463` / `device_removed` in the Baileys log stream or
a 401/403 connection close, freezes outbound for 6 h (cold sends 48 h), parks
queued rows as `held`, and requires manual release:
`POST /accounts/{id}/outbox/release` (admin key). A fresh QR link starts a 72 h
warm-up (halved daily cap, doubled gaps, cold budget 2/day).
`WA_OUTBOX=0` restores the pre-006 direct-send path.

## Config that must line up across ends

| Concept | Gateway env | Plugin env / vault |
|---|---|---|
| Shared HMAC secret | `WA_SHARED_SECRET` | `LUNA_WHATSAPP_SHARED_SECRET` or vault `plugin_whatsapp.shared_secret` |
| Where inbound goes | `LUNA_INBOUND_URL` (= `<luna>/api/p/plugin-whatsapp/inbound`) | (the route itself) |
| Gateway base URL | (its own origin) | `LUNA_WHATSAPP_GATEWAY_URL` |
| QR admin key | `GATEWAY_ADMIN_KEY` | `LUNA_WHATSAPP_GATEWAY_ADMIN_KEY` (only to proxy the QR) |

## Change checklist (use this every time you touch the boundary)

- [ ] Updated the envelope/response shape in `gateway/src/*` **and**
      `plugin/plugin_whatsapp/*`.
- [ ] Updated this doc's field tables.
- [ ] Kept `hmac.js` and `hmac.py` byte-identical (re-run the cross-language check).
- [ ] Bumped the plugin version in **both** `luna-plugin.toml` and the
      `PluginManifest` in `__init__.py` if the plugin's public surface changed.
- [ ] Added/updated a test in `plugin/tests/` (contract-shaped tests are cheap).
