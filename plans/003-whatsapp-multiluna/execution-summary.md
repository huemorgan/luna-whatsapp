# 003 — Multi-Luna gateway — Execution Summary

**Executed:** 2026-07-04 · **Outcome:** shipped
**Deployed:** https://luna-wa-gateway.onrender.com (commit `bf8dc7f`);
plugin-whatsapp v0.6.0 on marketplaces.com.ai official

## What was accomplished

Everything in the plan, same day:

- **Schema v2 + zero-downtime migration** — `whatsapp_accounts` registry
  (secret, inbound_url, status, caps, `gateway_id`), `whatsapp_state`
  deprecated, `whatsapp_chats` PK → `(account, chat_jid)`. Boot migration
  seeded `default` from env (counters carried over) and moved the flat auth
  dir; verified idempotent on a second boot.
- **Session refactor** — `wa.js` singletons → per-account `Session` class +
  `accounts.js` registry with lifecycle + HMAC→account resolution
  (`x-wa-account` hard bind / secret scan / legacy env fallback).
- **Admin API + per-account QR + `/stats.accounts[]`** — exactly the contract
  in luna-service's ask; existing `/stats` keys frozen.
- **Plugin v0.6.0** — vault-first account id, `x-wa-account` header, per-account
  QR proxy, "managed by your host" for tenants, version drift fixed. Published.
- **Tests**: 35 gateway unit (was 22), 82 plugin (was 75), live integration
  matrix on an isolated stack, dojo suite (all 14 scenarios passed across
  runs), production acceptance (scratch account lifecycle + isolation).

Amendment vs. plan: `WA_DRY_SEND=1` dev flag added (not in plan) — see below.

## What we discovered along the way

- **Latent watchdog bug in the old code**: the module-global
  `if (watchdogTimer) return` guard would have silently disabled watchdogs
  for sessions 2..N. The class refactor fixed it by construction.
- **Delete/close race**: after `DELETE /accounts/{id}`, the socket's async
  `connection.close` event overwrote the row's final `disabled` status with
  `logged_out`. Fixed with a `stopped` guard in the event handler. Found only
  by the live integration test — unit tests can't see it.
- **Dojo can't run against an unlinked gateway**: the plugin's reply send
  502s ("socket not connected"), and the reply is then never recorded. Hence
  `WA_DRY_SEND=1`: cap+capture without a socket. This is also generally
  useful for local dev without burning a real number.
- **Render auto-deploy doesn't fire on push** for this service — the repo is
  public and connected by URL, so no webhook exists. Deploys must be
  triggered via the Render API (or install the GitHub app).
- **Isolated dojo stacks are cheap**: a second Luna (uvicorn :3100, own PG
  database, `LUNA_MANAGED_DIR` pointing at a scratch plugin set) boots in
  ~12s and fully avoids stepping on other agents using :3000. The runner now
  takes `WA_DOJO_ENV` / `WA_DOJO_INBOUND_URL` overrides for this.
- **Dojo DB reuse pollutes recall scenarios**: planted messages from earlier
  runs (e.g. scenario 14's "booked the Berlin flight") leak into later runs'
  cross-chat context and read as fabrication to the judge. Fresh DB per run,
  or accept the noise.

## Things to consider in the future

- **Secrets at rest**: per-account secrets sit plaintext in Postgres;
  envelope-encrypt with a master-key env when hardening.
- **QR idle policy**: an unlinked session regenerates QR forever (Baileys 408
  loop). Fine at N≤5 accounts; add pause-after-30min + resume-on-QR-request
  before fleets of unlinked accounts exist.
- **Capacity**: ~60–120 MB RSS per linked session ⇒ 3–5 accounts on the
  starter instance. Bump the Render plan at 3 accounts; `gateway_id` sharding
  is designed but needs a per-instance advisory lock before instance #2.
- **Auth-dir rollback is one-way**: the flat→`default/` move doesn't reverse;
  a rollback deploy needs `WA_AUTH_DIR=/data/wa-auth/default`.
- **Wake-on-inbound for sleeping Fly machines is luna-service's problem** —
  deliberately excluded here; flagged in their 034 folder.
- **Dojo suite could get a fresh-DB bootstrap flag** to kill the recall
  pollution noted above.
