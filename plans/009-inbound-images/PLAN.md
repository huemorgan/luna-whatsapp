# 009 — Inbound images: Luna sees WhatsApp pictures

**Status:** PROPOSED
**Depends on:** Luna core plan `luna/plans/008.995-agent-image-input/` (the
`ctx.agent.run_turn(attachments=…)` contract). The plugin side degrades
gracefully on cores that don't have it yet, so ship order is core → plugin but
nothing breaks if a Luna lags.
**Ships:** gateway (same repo) + plugin-whatsapp 0.13.0.

## Problem

Someone sends a photo on WhatsApp ("what is this?", a receipt, a screenshot, a
product shot). Today the gateway parses it as `kind:"image"` with `body` =
caption only (`gateway/src/session.js:126`); the pixels are never downloaded.
The plugin renders the current message as `<image>` in the prompt
(`plugin_whatsapp/routes.py:_build_prompt`), so Luna answers blind. Same story
for stickers. Voice notes already got the equivalent treatment in 007 (download
→ ElevenLabs STT → text); images are the remaining blind spot.

## Design

Mirror 007's shape exactly: the gateway downloads the media at inbound time,
puts it on the envelope, the plugin feeds it to the agent, and every failure
degrades to today's caption-only behavior — an image must never block a message.

### Gateway

1. **Download.** In `handleMessage`, for inbound (`!fromMe && isNotify`) kinds
   `image` and `sticker`: `downloadMediaMessage(message, 'buffer', {}, {logger,
   reuploadRequest})` — the exact 007 voice pattern
   (`session.js:transcribeVoiceNote`).
2. **Caps + config** (new `config.media` block):
   - `WA_IMAGE_FORWARD` (default `1`) — master switch.
   - `WA_IMAGE_MAX_BYTES` (default `5242880` = 5 MB, matching the core cap) —
     skip download when `imageMessage.fileLength` exceeds it; skip forward when
     the downloaded buffer does.
3. **Envelope** (contract change, both ends + `vision/contract.md` table):
   ```json
   "media_b64":      "<base64 bytes> | null",
   "media_mimetype": "image/jpeg | image/webp | … | null"
   ```
   `null`/absent on non-image kinds, oversize, disabled flag, or any download
   error (log + degrade — never throw). `kind` stays `"image"`/`"sticker"`;
   `body` stays the caption. Note: base64 inflates the inbound POST ~33%; a
   5 MB cap keeps the payload < 7 MB, fine for the plugin's FastAPI route.
4. **Not stored.** The capture row (`whatsapp_messages`) keeps caption-only —
   no blobs in Postgres. Context/history stays text; only the *live* turn sees
   pixels (documented trade-off below).

### Plugin (0.13.0)

1. **Inbound:** when the envelope carries `media_b64` + an `image/*`
   `media_mimetype`, decode and build one attachment
   (`luna_sdk.TurnAttachment(data, media_type)` when available; else a small
   local duck-type with `.data`/`.media_type` — core reads attributes only).
2. **Call:** `ctx.agent.run_turn(prompt, attachments=[att], tools=…)`.
   **Graceful downgrade:** on `TypeError` (older core without the kwarg), retry
   once without attachments and append `"(An image was attached but this Luna
   version can't see images — say so if it matters.)"` to the prompt.
3. **Prompt:** in `_build_prompt`, when an attachment rides along, the current
   message renders as `Message: <image attached — see it below>` +
   caption if any, so the model connects prompt and pixels.
4. **Context blocks:** unchanged (`<image>`), history stays text-only.
5. **Settings UI:** move "understand images" out of no-man's-land — add a
   Messaging bullet "**See images** — photos and stickers sent to the linked
   number are understood in context" (no pending tag; needs no external key).

### Contract doc

`vision/contract.md`: add the two envelope fields + a "Images (009)" paragraph
mirroring the "Voice notes (007)" one.

## Trade-offs accepted

- **No image memory.** "What was in the photo I sent an hour ago?" won't work —
  attachments live for their turn only. Storing refs via the core
  `StorageProvider` is a natural follow-up once Luna's 008.95 executes; out of
  scope here.
- **Group volume:** every forwarded image is a model-input cost. `WA_IMAGE_MAX_BYTES`
  plus the existing activation policy (groups answer only on @mention/reply)
  bound it; if it bites, add a per-day image budget later.
- **Videos/documents stay blind** (thumbnail extraction and PDF understanding
  are separate slices).

## Tests

- **Gateway** (`node --test`, fake socket): image inbound → envelope has
  `media_b64` + mimetype; oversize → fields null, message still forwarded;
  `WA_IMAGE_FORWARD=0` → null; download throw → null + captured row intact.
- **Plugin** (pytest): envelope with `media_b64` → `run_turn` called with one
  attachment of the right media type; `TypeError` from `run_turn` → retried
  text-only with the downgrade note; no `media_b64` → exact current behavior.
- **Cross-language:** contract test that the new fields round-trip HMAC-signed
  (raw-body signing is unchanged, but the payload is now bigger — assert the
  5 MB-image case still signs/verifies).

## Acceptance

1. Send a photo with the caption "what brand is this?" to the linked number →
   Luna's reply references what is actually in the photo.
2. Send a 16 MB photo → Luna replies as today (caption-only), nothing errors.
3. Run the same against a Luna core *without* 008.995 → caption-only reply
   including the "can't see images" note; no crash, no double reply.

## Rollout

1. Land luna core 008.995 (separate repo/lineage — see its plan).
2. Gateway: merge, deploy to Render (`srv-d93stc8js32c73d4bg3g`), verify
   `/health` unchanged and a test image logs a forward with `media_b64`.
3. Plugin 0.13.0: pytest → publish to marketplace → Lunas pick it up.
4. Real-device test: photo DM, sticker, group @mention with photo.
