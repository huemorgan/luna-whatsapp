# 002 — WhatsApp full parity: execution report

**Date:** 2026-07-01 (overnight autonomous run)
**Goal:** WhatsApp = web app. Same agent, same tools, same output. Different screen.

## TL;DR

WhatsApp went from a **text-only, self-limiting** channel ("I can't send GIFs /
generate images / run playbooks from WhatsApp") to a channel with the **full
toolkit** and **native media delivery**. Proven live against the running gateway
+ Luna, with replies and media delivered to a real WhatsApp number. 51 automated
tests pass (40 plugin + 11 gateway).

## Before → after (same DB, real messages)

The gateway's `whatsapp_messages` table shows both eras side by side:

| time | what the agent said | era |
|---|---|---|
| 18:34–18:40 | "I don't have access to the playbook-building tools from WhatsApp" · "I can't generate images" · "I only have read-only WhatsApp tools here — I can't send GIFs" | **before** (REPLY_TOOLS whitelist) |
| 19:36 | "Live and ready on WhatsApp." | after |
| 19:38 | *(web_search)* "Anthropic Says Alibaba Stole 29 Million Conversations With Claude" — via AI Weekly | after |
| 19:39 | text + **image** (cat pic delivered as WhatsApp media) | after |
| 19:44 | **image** — screenshot of the Luna Playbooks view, with caption | after |

## What shipped (this repo)

### Plugin (`plugin-whatsapp/`, canonical submodule) — v0.2.0 → v0.3.0
- **P1.1 Full toolkit on the reply turn.** `routes.py` now computes the allowlist
  as *every registered tool minus* `{wa_send, wa_react, send_chat_message}`
  (`_reply_tools`), instead of the 3-tool `REPLY_TOOLS` whitelist. Unlocks
  web_search/web_fetch, files, recall/memory, render, monday, mcp, giphy,
  browser screenshots — the same tools the web app has.
  - Why exclude those 3: `run_turn` does **not** enforce tool approval policy, so
    an included `wa_send` would fire an ungated external send + double-post; the
    reply is deterministic (we send the returned text + referenced media).
- **P1.7 WhatsApp-native persona.** Rewrote `PERSONA` + the plugin
  `prompt_sections` note: "WhatsApp is a first-class channel, use your full
  toolkit, don't tell the user to go to the web app," plus chat-style formatting
  and a media-delivery convention (put a direct URL on its own line).
- **P3 Media delivery (`media.py` + `client.send_media`).** After the turn, the
  plugin extracts media URLs from the reply, delivers each as native WhatsApp
  media via the gateway, and strips the URL from the text caption. Best-effort by
  design — full fidelity needs the Luna-core change (see proposal).

### Gateway (`gateway/`)
- **P1.2 Typing indicator.** `setPresence()` + `withComposing()` wrap the inbound
  forward: sends `composing`, re-asserts every 8s (Baileys expires it ~10s), then
  `paused`. Presence errors never break the turn.
- **P1.3 Forward timeout.** `inbound.js` 20s → **120s**, and timeouts/aborts are
  no longer retried (a long turn may still be running; retry would double-send;
  the inbound is already durable in Postgres). *Validated:* the GIF turn took
  49.6s — it would have died under the old 20s limit.
- **P1.4 `/send-media`.** New signed endpoint + `sendMedia()`/`buildMediaContent()`
  supporting image/video/audio/document/sticker, via public `url` (gateway
  fetches) or inline `data_base64` (internal assets). Same send-cap + jitter as
  text. JSON body limit lifted to 25mb.
- **P1.5 Group names.** `handleMessage` resolves group subjects via
  `groupMetadata` (cached, 1h TTL, busted on `groups.update`) instead of always
  writing `chat_name = null`.

### Luna core — proposal only (not edited from here)
`luna-core-proposal.md`: (1) surface tool **artifacts** from `run_turn`, (2)
`chat_only` → `headless_allowed` opt-in (unlocks playbooks headless), (3) skills
in `run_turn`. All additive/backward-compatible. Verified against the current
`runtime.py`/`agent_facade.py`.

## Tests

- **Plugin (40 pass):** `test_media.py` (extraction/strip), `test_reply_tools.py`
  (allowlist contract + fallbacks), `test_inbound_flow.py` (HMAC gate, text
  reply + persistence, full-toolkit passthrough, image delivery, media-failure
  isolation, empty-reply) via real FastAPI + in-memory SQLite + fake agent.
- **Gateway (13 pass):** `node --test` — HMAC roundtrip/tamper, `toMediaUpload`,
  `buildMediaContent` per kind, `withComposing` safety.

## Live E2E (real gateway + Luna, delivered to WhatsApp)

Harness `sim_inbound.py` posts the exact HMAC-signed envelope the gateway posts,
driving the real agent + full toolkit + real reply delivery. `send_media.py`
delivers a local file as native media.

1. Text reply — `answered:true`, 9.5s, delivered.
2. Web search — real headline w/ source, 14s, delivered.
3. "send me a cat gif" — `media:1`, image delivered (49.6s; giphy key absent, agent adapted).
4. Playbooks screenshot (browser via Playwright MCP) → `/send-media` base64 → delivered w/ caption.

Screenshots: `screenshots/playbooks-view.png` (delivered to WhatsApp).

## Known gaps / decisions

- **Typing indicator not live-verified.** It fires only on a *real* inbound to
  the gateway; the sim posts plugin-direct. Code + unit-tested; visual confirm
  needs a message from a second WhatsApp account (not available autonomously).
- **Playbooks/image-gen from WhatsApp still blocked** by `run_turn`'s
  `chat_only` filter and artifact-dropping — needs the Luna-core proposal. Media
  delivery today relies on the model echoing a URL (best-effort).
- **giphy** returned "tools down" — needs a Giphy API key credential in Luna
  (per-plugin follow-up, not a code change here).
- **Duplicate plugin source (P1.6): NOT deleted.** Canonical = `plugin-whatsapp/`
  submodule; Luna loads from `~/.luna/managed_plugins/plugin_whatsapp` (now synced
  to it). The in-tree `plugin/` is stale but has **uncommitted tracked changes**,
  so deleting it autonomously would be data loss. Recommend: review its diff, then
  `git rm -r plugin/`.

## Per-plugin follow-ups (for full media parity, post Luna-core change)
- **plugin_giphy:** configure Giphy API key; ensure `search_gifs` returns public
  URLs (works with `media.py` today) and `send_gif*` surfaces a URL artifact.
- **plugin_browser:** `browser_screenshot` should return a `ToolArtifact`
  (url/bytes) so screenshots deliver to WhatsApp automatically.
- **plugin_web_access / files / render / monday / mcp:** already text-first, work
  today; benefit from artifacts only when they return files/images.
