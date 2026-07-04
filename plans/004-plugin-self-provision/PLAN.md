# 004 — Plugin self-provision: install IS the setup

**Produces version:** 0.8.0 (plugin only; gateway untouched)
**Driver:** `luna-service/plans/034.1-whatsapp-fix/plugin-ask.md` (2026-07-05).
Their ask says "v0.7.0" but 0.7.0 was published earlier today (settings UI
rework) and marketplace versions are immutable → this ships as **0.8.0**.

## Context

Hosted tenants can't see a QR: the plugin's QR proxy needs the gateway admin
key, which tenant machines must never hold. luna-service killed their admin
connect UI (034.1); instead every hosted machine carries `LUNA_GATEWAY_URL` +
`LUNA_GATEWAY_TOKEN`, and their control plane now exposes token-authed
`/api/agent/whatsapp/{connect,qr,status}` endpoints scoped to the calling
machine's own agent slug. The plugin should provision itself.

## Architecture impact

- `ADD: plugin auto-provisions via control-plane token endpoints → vision/luna-integration.md § plugin config` (gateway contract unchanged)
- `ALIGNED: inbound envelope + HMAC unchanged → vision/contract.md` (their ask §"Inbound stays exactly as in v0.6.0")
- `ADD: plugin_whatsapp.gateway_url vault key (vault-first, env fallback) → vision/contract.md § plugin config keys`

## Both-ends checklist

Single-end change (plugin only). `hmac.py`/`hmac.js` untouched. The gateway's
admin API is consumed by luna-service's control plane, not by this plugin.

## Goals

1. Fresh install on a hosted Luna: `on_load` silently provisions (vault gets
   `shared_secret`/`account_id`/`gateway_url`); settings tab shows the QR with
   zero manual steps. Idempotent: re-load with a filled vault makes no call;
   a re-connect response without `secret` leaves the stored one intact.
2. Settings tab drives everything through the plugin's server-side proxies of
   the control-plane endpoints (token never reaches the browser): status pill,
   inline QR (only when scannable), sent-today/cap, Connect + Disconnect.
3. Deletions (no compat per the ask): `LUNA_WHATSAPP_GATEWAY_ADMIN_KEY` env and
   the admin-key QR proxy. Self-hosted flow = manual env/vault config; the
   settings tab explains it and points at the gateway's own `/qr?key=…` page.
4. `gateway_url` becomes vault-first (`plugin_whatsapp.gateway_url`) with env
   fallback — `client.gateway_url` goes async; all call sites updated.

## Non-Goals

- Gateway changes (its `/accounts` admin API already serves the control plane).
- The control-plane endpoints themselves (luna-service built them, 034.1).
- Inbound path changes.

## Approach

1. `client.py` — shared `_vault_get()` helper; async `gateway_url()`
   (vault→env); control-plane surface: `control_plane(ctx)` detection +
   `cp_connect/cp_status/cp_qr/cp_disconnect` (Bearer token).
2. `provision.py` (new) — `ensure_provisioned(ctx, force=False)`: detect mode
   (hosted/manual), call connect, write vault keys, tolerate absent `secret`
   on idempotent re-connect. Injectable connect callable for tests.
3. `__init__.py` — schedule best-effort provisioning from `on_load`
   (same fire-and-forget pattern as the install greeting).
4. `routes.py` — `/status` gains `mode` + provisioning info; `/qr` proxies the
   control-plane QR (hosted) or explains manual mode; `POST /connect` (explicit,
   surfaces errors), `DELETE /connect` (unlink + clear vault keys); settings
   HTML gains connect/disconnect actions and the hosted/manual split.
5. Bump both manifests + `PluginManifest` to 0.8.0.

## Risks

- `on_load` provisioning must never break plugin load → background task,
  all exceptions swallowed (greeting pattern).
- A hosted machine with a stale vault `gateway_url` after gateway migration →
  control plane returns the current one on every connect; the explicit
  Connect button re-syncs.
- Token leakage → only server-side routes touch it; acceptance includes a
  page-source check.

## Acceptance criteria

- [ ] Hosted fresh install: on_load provisions; settings shows QR unaided
- [ ] Idempotent re-load: vault hit → no connect call; secret survives
- [ ] Self-hosted (no token): zero control-plane calls; manual instructions;
      env-configured setup still works end-to-end
- [ ] No admin key / tenant token anywhere in settings page source
- [ ] pytest suite green; dojo conversation suite green on the isolated stack
- [ ] v0.8.0 on marketplaces.com.ai; both manifests locked at 0.8.0

## Verification

- `pytest -q` (plugin), incl. new provision/vault-first tests
- dojo: isolated Luna :3100 (v0.8.0 managed) + gateway :10100 `WA_DRY_SEND=1`
- manual: hosted-mode simulation with a stub control plane (httpx-served)
