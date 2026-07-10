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
| GET | `/health` | none | – | `{status, connected, self_jid, has_qr, last_activity_at, sent_today}` |
| GET | `/qr?key=<GATEWAY_ADMIN_KEY>` | admin key | – | HTML QR page (auto-refreshes; shows "linked" once connected) |
| POST | `/send` | HMAC | `{chat_jid, text, reply_to?}` | `{ok, chat_jid, wa_msg_id}` |
| POST | `/send-media` | HMAC | `{chat_jid, kind, url?\|data_base64?, caption?, mimetype?, file_name?, reply_to?, gif_playback?, ptt?, ptv?}` | `{ok, chat_jid, wa_msg_id}` |
| POST | `/react` | HMAC | `{chat_jid, wa_msg_id, emoji}` | `{ok}` |
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
→ `wa.js::sendText`.

```json
// request
{ "chat_jid": "…", "text": "reply text", "reply_to": "wa_msg_id or null" }
// response
{ "ok": true, "wa_msg_id": "the sent message id (the ack)" }
```

A send is only "done" when Baileys returns the outbound `wa_msg_id`. The gateway
also enforces the daily cap and jitter here.

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
