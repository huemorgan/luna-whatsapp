# 002 — WhatsApp full capability parity

**Goal:** WhatsApp = web UI. Same agent, same tools, same output. Different screen.

**Status:** Phase 1 DONE + shipped live (2026-07-01). Phase 2 = proposal written
(`luna-core-proposal.md`). Phase 3 = best-effort media shipped; full fidelity
awaits Luna core. See `EXECUTION_REPORT.md` for evidence.

- P1.1 full toolkit · P1.2 typing · P1.3 timeout→120s · P1.4 /send-media ·
  P1.5 group names · P1.7 persona — **all shipped & live**.
- P1.6 duplicate `plugin/` — **not deleted** (uncommitted changes; documented).
- Tests: 40 plugin + 13 gateway pass. Live E2E: text, web-search, image/GIF,
  screenshot all delivered to real WhatsApp.

## The gap

Today the WhatsApp reply path is crippled in three ways:

1. **Tools are whitelisted** — `REPLY_TOOLS` in `routes.py` limits the agent to
   `[wa_context, wa_list_chats, recall_conversation]`. No web search, no image gen,
   no file tools, no memory write, nothing else.

2. **Media can't be delivered** — the gateway only has `sendText`. Even if the agent
   generates an image, there's no way to send it. Baileys supports image/video/audio/
   doc/sticker natively via `sock.sendMessage(jid, { image: buffer })`.

3. **`run_turn` doesn't surface tool artifacts** — when `image-gen` runs inside
   `run_turn`, the generated image URL (`embed_html`/`embed_iframe`) lives in an
   intermediate tool result that's fed back to the model but **not returned to the
   caller**. The plugin only sees the model's final text ("here's the image"), not the
   actual image. This is a Luna core limitation — `run_turn` was designed for headless
   text output.

Plus operational issues: no typing dots, forward timeouts, null group names, duplicate
plugin source.

## What lives WHERE

| Fix | Repo | Why |
|-----|------|-----|
| Remove `REPLY_TOOLS` whitelist | **here** (plugin) | Pass `tools=None` to `run_turn` → agent gets all non-chat-only tools |
| Typing indicator ("..." dots) | **here** (gateway + plugin) | Gateway calls `sendPresenceUpdate('composing')` |
| Forward timeout | **here** (gateway) | Increase abort from 20s or make fire-and-forget |
| Gateway send-media endpoint | **here** (gateway) | New `/send-media` + `sendMedia()` using Baileys |
| Group `chat_name` | **here** (gateway) | Use `groupMetadata` to resolve subject |
| Duplicate plugin source | **here** (repo) | Delete in-tree `plugin/`, keep submodule `plugin-whatsapp/` |
| Surface tool artifacts from `run_turn` | **Luna core** | `run_turn` needs to return embeds/files alongside text |
| Unblock `chat_only` tools for plugins | **Luna core** | `playbook_run` etc. are excluded by design — needs a new flag |
| Skill-gated tools in `run_turn` | **Luna core** | `load_skill` not injected in headless turns |
| Plugin media extraction + send | **here** (plugin) | After Luna surfaces artifacts — parse URLs, fetch bytes, send via gateway |

## Approach — two phases

### Phase 1: everything we can do NOW (this repo)

All changes in `gateway/` and `plugin-whatsapp/`. No Luna core changes needed.

#### P1.1 — Remove tool whitelist
**File:** `plugin-whatsapp/plugin_whatsapp/routes.py`

Change `run_turn(prompt, tools=REPLY_TOOLS, ...)` → `run_turn(prompt, tools=None, ...)`.

With `tools=None`, the agent gets every registered tool **except** `chat_only=True`
(playbooks, navigation) and `skill_gated=True`. This immediately unlocks:
- `web_fetch` / `web_search` — browse/search the web
- `memory_recall` / `memory_write` — cross-chat memory
- `file_read` / `file_write` — file operations
- `image-gen` — image generation (if plugin-image-gen is loaded)
- Every other standard Luna tool

Keep `wa_context`, `wa_list_chats` registered as they are — they'll be included
automatically. Delete the `REPLY_TOOLS` constant.

**Caveat:** `image-gen` will run and the model will say "here's the image" but the
image won't actually be delivered until Phase 2. We'll handle that with a prompt note
for now: tell the agent to describe images in text when on WhatsApp, or give a link.

#### P1.2 — Typing indicator (composing dots)
**Files:** `gateway/src/wa.js`, `gateway/src/index.js`, `plugin-whatsapp/plugin_whatsapp/routes.py`

Gateway side:
- Export `sendPresenceUpdate(type, chatJid)` from `wa.js` — thin wrapper around
  `sock.sendPresenceUpdate(type, chatJid)`.
- Add `POST /composing` endpoint in `index.js` — HMAC-signed, body:
  `{ chat_jid, status: 'composing'|'paused' }`. Or simpler: auto-send composing
  inside `forwardInbound` before the HTTP call, and paused after reply.

Simpler approach (no new endpoint): gateway sends `composing` before forwarding to
Luna, and `paused` after receiving the response. This is better because:
- No extra HTTP round-trip
- The composing starts the instant the message arrives
- Paused happens naturally when Luna responds (or forward times out)

```javascript
// In wa.js or inbound.js, before forwardInbound:
await sock.sendPresenceUpdate('composing', chatJid);
// ... forward and wait for response ...
await sock.sendPresenceUpdate('paused', chatJid);
```

But `forwardInbound` is fire-and-forget with retries. Better: put composing in
`handleMessage` right before the forward call, and add a composing keepalive
(Baileys composing expires after ~10s, so repeat every 8s while waiting).

**Implementation:**
1. `wa.js` — export `setPresence(type, jid)` wrapping `sock.sendPresenceUpdate`
2. `wa.js` `handleMessage` — after capture, before `forwardInbound`:
   - Call `setPresence('composing', chatJid)`
   - Start an 8s interval repeating `composing`
3. `inbound.js` `forwardInbound` — return a result object. On return (success or
   failure), clear the interval and send `paused`.
4. Also send `paused` after `sendText` completes (in case the plugin calls `/send`
   directly).

#### P1.3 — Fix forward timeout
**File:** `gateway/src/inbound.js`

Current: `AbortSignal.timeout(20000)` — 20s per attempt, 3 attempts = 60s max.

Problem: `run_turn` with full tools (web search + image gen) can take 30-60s easily.
The forward times out, the plugin never gets the message, no reply is sent.

Fix: increase to 120s (agent turns shouldn't take longer; if they do, something is
wrong). Also, the forward doesn't need to wait for the reply — the plugin calls
`/send` back to the gateway independently. So we could make it truly fire-and-forget:
just POST and don't wait for the response body.

**Decision:** Make it fire-and-forget. The gateway's job is to deliver the inbound
envelope; the plugin's job is to reply via `/send`. The gateway shouldn't block on
the plugin's LLM call. Still keep a reasonable timeout (30s) for the HTTP connection
itself, but don't retry on timeout (the message is already captured in Postgres).

```javascript
// inbound.js — fire-and-forget with short connection timeout
const res = await fetch(config.lunaInboundUrl, {
  method: 'POST',
  headers: { ... },
  body,
  signal: AbortSignal.timeout(30000),  // 30s connection timeout
});
// Don't block on response body — Luna will call /send when ready
```

Actually better: keep the current model (wait for response) but bump timeout to 120s
and reduce retries to 1. The response tells the gateway whether Luna answered, which
is useful for logging. The composing keepalive handles the UX during the wait.

#### P1.4 — Gateway send-media endpoint
**Files:** `gateway/src/wa.js`, `gateway/src/index.js`, `vision/contract.md`

Add `sendMedia(chatJid, kind, source, opts)` to `wa.js`:
- `kind`: `'image'|'video'|'audio'|'document'|'sticker'`
- `source`: Buffer or `{ url: string }` — Baileys handles both
- `opts`: `{ caption, mimetype, fileName, ptt, replyToWaId }`

Add `POST /send-media` to `index.js`:
- HMAC-signed
- Body: `{ chat_jid, kind, url, caption?, mimetype?, file_name?, reply_to? }`
- `url` is a fetchable URL (the plugin will pass the Luna server's
  `/api/p/plugin-image-gen/file/{id}` or similar). Gateway fetches the bytes and
  sends via Baileys.

**Why URL-based:** the plugin has access to the image via Luna's internal URL. The
gateway fetches it (same-network in production). Avoids base64 in JSON (bloated) and
avoids the plugin needing to read file bytes.

Update `vision/contract.md` with the new endpoint spec.

#### P1.5 — Fix group `chat_name`
**File:** `gateway/src/wa.js`

Line 100: `chat_name: kind === 'group' ? (message.pushName ? null : null) : ...` —
both branches return null.

Fix: cache group metadata and populate `chat_name` with the group subject.

```javascript
const groupNameCache = new Map();

async function getGroupName(jid) {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    groupNameCache.set(jid, meta.subject);
    return meta.subject;
  } catch {
    return null;
  }
}
```

Call it in `handleMessage` for group messages. Cache invalidation: clear on
`groups.update` event or TTL-based (1h is fine).

#### P1.6 — Delete duplicate plugin source
Remove in-tree `plugin/` directory entirely. The submodule `plugin-whatsapp/` is the
canonical source. Update any references in `render.yaml`, `vision/codemap.md`, README.

#### P1.7 — WhatsApp-aware prompt tuning
**File:** `plugin-whatsapp/plugin_whatsapp/routes.py`

Update `PERSONA` to tell the agent:
- You can use all your tools (web search, image gen, memory, files, etc.)
- Images you generate can't be displayed inline yet — describe them or give a
  download link (temporary until Phase 2 connects media delivery)
- Keep replies WhatsApp-native: short, chat-style, no markdown headers
- Voice messages are possible (future); for now, text only

### Phase 2: Luna core proposal (recommendation for `../luna`)

Write `luna/plans/009-plugin-run-turn-artifacts/recommendation.md` — a proposal for
the Luna team to ship these changes:

#### P2.1 — Surface tool artifacts from `run_turn`

Today `run_turn` returns `(str|dict, RunUsage)`. Tool results with `embed_html`/
`embed_iframe` are fed to the model but discarded from the return value.

**Proposal:** return a richer result:

```python
@dataclass
class RunTurnResult:
    text: str | dict
    usage: RunUsage
    artifacts: list[ToolArtifact]  # new

@dataclass
class ToolArtifact:
    tool_name: str
    embed_html: str | None
    embed_iframe: str | None
    file_url: str | None
    mimetype: str | None
```

Or simpler: `run_turn` returns `(text, usage, tool_results: list[dict])` where
each dict is the raw tool result JSON (the plugin can parse for embeds).

This lets the WhatsApp plugin extract image URLs from tool results and send them
via the gateway's `/send-media`.

#### P2.2 — `chat_only` → `headless_allowed` flag

`playbook_run`, `playbook_propose`, etc. set `chat_only=True` to prevent recursion.
But a plugin webhook isn't "chat" — it's a different context. Add
`headless_allowed=True` on tools that are safe for plugin `run_turn` (playbooks
probably are, since the plugin isn't inside a playbook step).

Or: let the plugin explicitly opt in with `tools=["playbook_run", ...]` override.

#### P2.3 — Skills in `run_turn`

`load_skill` isn't injected in headless turns. For full parity, the WhatsApp agent
should be able to load skills. This may be lower priority — skills are a power-user
web feature.

### Phase 3: connect media delivery (this repo, after Luna ships Phase 2)

#### P3.1 — Plugin extracts and sends media

After `run_turn` returns artifacts:
1. Parse each `ToolArtifact` for image/file URLs
2. Fetch the bytes from Luna's internal URL (same server, localhost)
3. POST to gateway `/send-media` with the bytes/URL
4. Send the text part via `/send` as before

This gives full image delivery: agent generates image → plugin extracts URL →
gateway sends image on WhatsApp.

#### P3.2 — Playbook results on WhatsApp

With `chat_only` unblocked, the agent can run playbooks during a WhatsApp turn.
Playbook step results flow through `run_turn` as tool results → extracted as
artifacts → sent as text/media on WhatsApp.

## Execution order

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 1 | P1.1 Remove tool whitelist | 5 min | — |
| 2 | P1.7 Prompt tuning | 10 min | P1.1 |
| 3 | P1.3 Fix forward timeout | 10 min | — |
| 4 | P1.2 Typing indicator | 30 min | — |
| 5 | P1.5 Group chat_name | 20 min | — |
| 6 | P1.4 Gateway send-media | 45 min | — |
| 7 | P1.6 Delete duplicate plugin/ | 5 min | user OK |
| 8 | P2.* Luna proposal | 30 min (write doc) | — |
| 9 | P3.* Media delivery | 1-2h | Luna ships P2 |

Items 1-7 are all in this repo. Item 8 is a doc in the Luna submodule. Item 9 waits
for Luna.

## Acceptance criteria

- [ ] Agent uses full tool set on WhatsApp (tools=None)
- [ ] Typing dots appear while Luna is thinking
- [ ] Forward doesn't timeout on slow agent turns
- [ ] Gateway can send images/docs/audio via `/send-media`
- [ ] Group messages show group name, not null
- [ ] One canonical plugin source (submodule only)
- [ ] Prompt tells the agent it's on WhatsApp with current limitations
- [ ] Luna proposal written for P2 (tool artifacts, chat_only flag)
- [ ] (After Luna P2) Images generated by agent are delivered on WhatsApp
