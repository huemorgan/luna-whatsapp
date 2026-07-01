# Roadmap, known gaps, and acceptance

## Status: MVP built, not yet deployed

Done and verified locally:
- Gateway boots, connects to WhatsApp, generates a QR, initializes the Postgres
  schema, serves `/health` and `/qr` (admin-key gated).
- Plugin: 17 unit tests pass (HMAC, context window, policy, manifest sync, no
  forbidden imports). HMAC is byte-identical across Node and Python.

Not done (requires the owner):
- Deploying the gateway to Render (needs the owner's Render account + a GitHub repo).
- Scanning the QR on a dedicated number's phone.
- Wiring the plugin into a real Luna and confirming a live round-trip.

## Phases

### Phase 0 — MVP loop (this repo, current)
Gateway skeleton + plugin skeleton + the signed contract. Goal: **one real reply**
on WhatsApp from a live Luna, end to end.

### Phase 1 — Context + policy polish
- Cross-chat auto-injection tuning; verify the group-A→group-B scenario live.
- Group mention gating, debounce of bursts into one turn, per-chat overrides.
- Settings UI: allowlist + persona editing (not just status/QR).

### Phase 2 — Hardening
- Outbox with delivery acks + retry/backoff; treat "sent" only on Baileys id.
- Heartbeat → Luna + stale-connection alerting (WhatsApp DM to owner / email).
- R2 (or disk) backup of the Baileys auth dir; documented re-link playbook.
- Reconcile/backfill on reconnect after a gateway deploy gap.
- PII: encrypt buffer where possible, short buffer TTL, redact logs.
- Ban-risk: pacing caps + jitter (basic version already in `wa.js`), monitoring.
- Media: download + store to object storage; inbound voice transcription.

### Phase 3 — Multi-tenant (hosted luna-service)
The big one. Turn the single-owner gateway into a multi-tenant one:
- N Baileys sessions, one per linked tenant number; a `wa_sessions` registry keyed
  by `tenant_id`, with a `gateway_id` column for sharding across instances.
- Inbound reuses the luna-service Composio-style relay/forwarder: verify Standard
  Webhooks HMAC → resolve number→tenant `Agent` → enqueue a `wa_delivery` →
  forwarder re-signs with the per-agent secret, wakes the sleeping Fly machine,
  POSTs the tenant's plugin `/inbound`, retries/backoff/dead-letter.
- Strict per-tenant isolation: auth dirs, buffers, R2 prefixes all namespaced.
- Per-tenant "Connect WhatsApp" QR flow in the luna-service UI.
This lives under luna-service's own devprocess (`luna-service/plans/…`). Gateway
code would move to `luna-service/wa-gateway/`. **Never edit the read-only `luna/`
submodule from luna-service** — Luna-core changes go through a proposal.

## Known gaps / decisions to revisit

1. **`run_turn` is headless** — WhatsApp turns aren't first-class Luna
   conversations (no stream/named-conversation persistence). MVP accepts this ("v1").
   "v2" needs a Luna-core enabler — a proposal, not a change in this repo.
2. **One Luna conversation per WhatsApp chat vs. one labeled conversation** — the
   plugin currently keeps its own message store rather than mapping chats to Luna
   conversations. Revisit if/when recall/threading needs first-class conversations.
3. **Debounce** of rapid message bursts into one turn is specced but not yet
   implemented in the MVP `/inbound` path.
4. **Same-Postgres vs separate** for gateway store and plugin store — logically
   distinct today; physically may be the same DB in the MVP.
5. **Media** is captured as a placeholder (`media_path` null); no download yet.

## Acceptance criteria ("MVP done")

- Scan `/qr` once → linked; gateway survives a forced restart + a 60s network drop
  and reconnects **without re-scanning**; no inbound lost (all in
  `whatsapp_messages`).
- 100% capture: every DM + every group message (including non-triggering ones) is
  in the DB.
- DM from an allowlisted number → Luna replies on WhatsApp; reply only marked sent
  on ack.
- Group: a non-mention message is saved but not answered; an @mention is answered.
- Cross-chat: say X in group A, then in group B (≤5 min / 30 msgs) reference "what I
  said about X" → agent answers correctly from injected context.
- Luna restart mid-conversation → no double-answer, no lost message.

## Testing philosophy

- **Unit** (this repo): pure logic (`hmac`, `context`, `policy`) + the data
  contract (`luna-plugin.toml` ↔ code) + the forbidden-import guard. No network, no
  Luna runtime.
- **Integration** (manual for MVP): a real Luna + the deployed gateway + a real
  scanned number, walking the acceptance list above.
- When adding features, prefer a contract-shaped unit test (feed an envelope, assert
  the decision/output) before wiring the live path.
