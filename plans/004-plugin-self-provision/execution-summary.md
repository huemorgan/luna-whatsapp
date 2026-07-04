# 004 — Plugin self-provision — Execution Summary

**Executed:** 2026-07-04 · **Outcome:** shipped
**Deployed:** plugin-whatsapp **v0.8.0** on marketplaces.com.ai official
(commit `1e8ee1e`, tag `v0.8.0`); gateway untouched.

## What was accomplished

All of `luna-service/plans/034.1-whatsapp-fix/plugin-ask.md`, shipped as
**0.8.0** (their ask said 0.7.0, but 0.7.0 was published hours earlier for
the settings rework and marketplace versions are immutable):

- `provision.py`: hosted Lunas self-provision on load via the control plane
  (`LUNA_GATEWAY_URL`/`LUNA_GATEWAY_TOKEN`); vault gets
  `shared_secret`/`account_id`/`gateway_url`. Idempotent; secret-less
  re-connects keep the stored secret; failures never break plugin load.
- Vault-first `gateway_url` (`client.gateway_url` went async; all call sites).
- Settings tab: hosted/manual modes, Connect + Disconnect buttons, QR inline
  only when scannable, WhatsApp dark palette, zero raw JSON.
- Deletions per the ask: `LUNA_WHATSAPP_GATEWAY_ADMIN_KEY` + admin-key QR
  proxy. Self-hosted = manual env/vault + the gateway's own `/qr?key=…` page.
- Tests: 91 pytest (9 new). Dojo on a fully isolated hosted stack: fresh
  gateway (:10100, zero accounts at boot), a **stub control plane** (:3299)
  implementing their 034.1 endpoints against the real gateway admin API, and
  a Luna (:3100) with ONLY the CP token env — auto-provision created the
  account, QR proxied inline, cross-account token-leak check clean,
  disconnect disabled the account and cleared the vault.

## What we discovered along the way

- **luna-core run_turn narration leak (NOT this repo):** 2/14 dojo scenarios
  failed with internal reasoning leaking into replies ("Now I have enough
  information… Let me compile…") on multi-tool turns. The plugin sends
  run_turn's string verbatim (unchanged since v0.5.0); the sibling `luna`
  checkout jumped 0.23→0.27 overnight (E10 turn contract) and
  `runtime.run_turn` returns pydantic-ai's `output`, which now includes
  pre-final text parts. Needs a luna-core fix (take only the FINAL text
  part); flagged to the luna-service agent in the 034.1 reply.
- A boot-time `/status` can briefly report `provisioned: false` while the
  background provision is mid-flight (the gateway account create takes a few
  seconds). Self-heals; the settings page polls.
- The stub-control-plane pattern (50 lines of stdlib Python fronting the real
  gateway admin API) is a cheap way to test the full hosted flow with no
  luna-service deployment in the loop — reusable for future plugin work.
- Gateway boots correctly with zero accounts and no legacy env — the 003
  "env optional" design held up in practice.

## Things to consider in the future

- **Luna-core proposal**: run_turn should expose final-text-only (or a
  structured {text, parts}) — until then every headless channel (WhatsApp,
  future SMS/Slack) risks narration leaks on multi-tool turns.
- The install greeting still says "connect in Settings → WhatsApp" even on
  hosted Lunas where provisioning is automatic and only the scan remains —
  could be state-aware (greet with "scan the QR" when a QR is already up).
- `POST /connect` passes `force=False`; a "Re-sync" affordance (force=True,
  pulls a fresh gateway_url after a gateway migration) may be wanted when
  sharding lands.
- Dojo scenario 05 (GIF) is flaky across runs (GIPHY delivers PNG stills
  sometimes) — consider pinning the scenario to accept either or fixing the
  giphy plugin's mp4 rewrite.
