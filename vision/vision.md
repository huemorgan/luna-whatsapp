# luna-whatsapp — Vision

> Read this first. It is the north star for anyone (human or agent) building on
> this repo. The companion docs go deeper:
> [`architecture.md`](architecture.md) (how the pieces fit),
> [`contract.md`](contract.md) (the wire contract that MUST stay in sync across
> both ends), [`communication.md`](communication.md) (how Luna talks, remembers,
> and behaves on WhatsApp — the reply-experience north star),
> [`luna-integration.md`](luna-integration.md) (the Luna/`luna_sdk`
> surface the plugin depends on), [`roadmap.md`](roadmap.md) (phases, gaps,
> acceptance), and [`codemap.md`](codemap.md) (where every file lives and which
> end it belongs to).

## One sentence

Scan a QR code once and your **Luna** agent lives on **WhatsApp** — reading and
replying to DMs and group @mentions, with memory of what was said across your
other chats.

## Why this exists

Luna is an agent core made of plugins. It has no built-in chat-channel concept.
WhatsApp is where a huge amount of real conversation happens — DMs and, crucially,
**groups**. The official WhatsApp Business Cloud API does not support groups and is
slow to set up, so to get true "Luna is in my WhatsApp, including my groups, right
now" we use **WhatsApp Web via Baileys** (unofficial, QR-linked, group-capable).

Baileys needs a **single always-on owner of the socket**. Luna itself is
ephemeral (it restarts/redeploys, and in the hosted product each tenant's Luna can
even sleep). So the WhatsApp connection **cannot** live inside Luna. That single
constraint produces the whole shape of this project: a **separate always-on
gateway** owns WhatsApp; **Luna talks to it over a signed HTTP contract**.

## Who it is for

- **v1 (this repo's MVP):** a single owner — you — linking one dedicated number to
  your own Luna. "I want to scan a QR and have Luna on WhatsApp."
- **Phase 2:** the hosted, multi-tenant luna-service product, where many customers
  each link their own number. Same gateway shape, multiplied. See
  [`roadmap.md`](roadmap.md).

## The two ends (never forget there are two)

This is the mental model that matters most when fixing bugs:

1. **The gateway end** — `gateway/`, Node + Baileys, deployed always-on (Render).
   Owns the socket, the QR, 100% message capture, and outbound sending.
2. **The Luna plugin end** — `plugin/plugin_whatsapp/`, Python, loaded inside
   Luna. Decides whether to answer, builds context, runs the agent, sends replies
   back through the gateway.

They meet at exactly one place: **the wire contract** (HMAC-signed HTTP, described
in [`contract.md`](contract.md)). **Any change to the shape of a message crossing
that boundary is a change to BOTH ends.** If you edit `gateway/src/inbound.js`'s
envelope, you edit `plugin/plugin_whatsapp/routes.py`'s parser too — and vice
versa. The contract doc exists so that pairing is never missed.

## Product principles (the non-negotiables)

1. **Capture 100%, decide later.** Every inbound and every outbound message is
   written to durable storage *before* any activation/agent decision. A restart on
   either end must never lose a message or produce a duplicate reply. Idempotency
   key: `wa_msg_id`.
2. **One socket owner.** Only the gateway opens a WhatsApp socket. Luna *sends by
   calling the gateway*, never by connecting itself. This is what makes Luna's
   ephemerality safe.
3. **Signed on every hop.** Gateway↔plugin traffic is HMAC-signed with a shared
   secret. No signature, no action.
4. **Cross-chat memory is the headline feature.** In group B, the agent can
   reference something said in group A within the last 5 minutes / 30 messages,
   owner-global, attributed by chat and sender. This is the thing that makes it
   feel like "my assistant is actually in my WhatsApp," not a dumb autoresponder.
5. **Answer with judgment, not on every message.** DMs: allowlist. Groups: only on
   @mention or reply-to-bot. Everything else is still captured (for context) but
   not answered.
6. **WhatsApp-native voice.** Short, chat-style replies. Don't dominate groups.
   Never claim a delivery that wasn't acked. Never leak one chat's private content
   into another.
7. **Respect the platform's risk.** Baileys is unofficial. Dedicated number,
   send pacing + daily cap + jitter, allowlist-first, and a documented migration
   path to the official Business API for compliance/scale.
8. **`luna_sdk` only on the plugin side.** The plugin imports `luna_sdk` and
   nothing from `luna.*`. That is what keeps it portable and installable from a
   marketplace. See [`luna-integration.md`](luna-integration.md).

## What "working" looks like (success)

- You scan the QR once; the link survives gateway restarts/redeploys without a
  re-scan.
- A DM from an allowlisted contact gets a sane, short Luna reply on WhatsApp.
- In a group, @mentioning the number gets a reply; ordinary group chatter does
  not, but is remembered.
- You say something in group A, then in group B (within 5 min) ask "what did I just
  say about X?" and Luna answers correctly — because it injected cross-chat
  context.
- Nothing is ever lost or double-answered across restarts on either end.

Full, testable acceptance criteria live in [`roadmap.md`](roadmap.md).

## Explicit non-goals (for the MVP)

- Not the official WhatsApp Business Cloud API (kept as a documented fallback).
- Not multi-tenant (that's Phase 2 / luna-service).
- Not media understanding beyond capture (images/audio are recorded; transcription
  and vision are later).
- Not a full outbox/retry state machine on day one (send acks + light retry only;
  hardening is a later phase).
