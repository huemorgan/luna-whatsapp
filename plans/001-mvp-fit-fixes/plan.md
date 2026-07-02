# 001 — Make the MVP actually reply (gateway ⇄ plugin ⇄ Luna fit fixes)

**Produces version:** plugin 0.2.0 (contract/behavior change) · gateway unchanged (0.1.0)
**Status:** in progress — **B1 resolved** (Luna shipped the `ctx.agent` facade,
008.993, pulled into the `luna/` submodule); **B2 fixed** (policies → `prompt_always`,
docs synced, guard test added); **S4 resolved** (`recall_conversation` is a real
shipped tool). Plugin tests **green: 20 passed**. Remaining: S1 (delete in-tree
`plugin/` — needs user OK), S2 (vault slot vs env-only), S3 (group `chat_name`).
**Scope:** integration review of `gateway/`, `plugin-whatsapp/` (submodule), and the
`luna/` submodule (`luna_sdk` + core), and the fixes needed to get one real reply.

## Verdict

**No — it does not all fit yet.** The wire contract between the gateway and the
plugin is solid, but the plugin's **inbound → agent → reply** step depends on
`ctx.agent`, which Luna core **never populates for plugins**. As written, every
inbound message returns `503 "agent not ready"` and no reply is ever sent. There is
also an approval-bypass bug on the proactive `wa_send`/`wa_react` tools. Details +
fixes below.

## What DOES fit (verified, keep as-is)

- **HMAC is byte-identical.** `gateway/src/hmac.js` and
  `plugin-whatsapp/plugin_whatsapp/hmac.py` both compute
  `hex(HMAC_SHA256(secret, f"{ts}.{rawBody}"))`, same 300s skew, constant-time
  compare, verify against the raw received bytes. ✓
- **Inbound envelope matches** `vision/contract.md` on both ends
  (`gateway/src/wa.js` `forwardInbound` ↔ `routes.py` `inbound` parser). ✓
- **`/send` and `/react`** request/response shapes match (`client.py` ↔
  `gateway/src/index.js`). ✓
- **SDK surface the plugin imports exists.** `LunaPlugin, PluginManifest,
  PluginContext, SettingsTab, ToolDef, declarative_base, UUID` are all exported by
  `luna/luna_sdk/__init__.py`. ✓
- **`run_turn` signature matches** the call. Core:
  `run_turn(prompt, *, output_schema, tools, identity, memory_write, memory_read)`
  (`luna/luna/agent/runtime.py:1028`); plugin calls
  `run_turn(prompt, tools=REPLY_TOOLS, memory_read=True, memory_write=True)`. ✓
- **`tool_registry.register(plugin, definition, handler, ...)`** matches
  (`luna/luna/plugins/tool_registry.py:27`). ✓
- **Route mounting matches.** Core imports `<entry>.<routes_module>` and calls
  `register_routes(app, ctx)` (`luna/luna/plugins/loader.py:659-675`); the plugin
  defines exactly that. ✓
- **Manifest fields valid.** `category="connectors"` coerces to
  `PluginCategory.CONNECTORS`, `license="MIT"`, `depends_on`, `routes_module`,
  `settings_tabs` all accepted (`luna/luna/plugins/base.py`). ✓

## Blockers (MVP won't work until these are fixed)

### B1 — `ctx.agent` is always `None` for plugins → inbound always 503  ✅ RESOLVED (Luna 008.993)

**Resolution:** Luna core shipped the **E10 sub-agent/turn contract**. The loader now
attaches a `PluginAgentFacade` to `PluginContext.agent` for both `on_load` and routes
contexts (`luna/luna/plugins/agent_facade.py`, `loader.py`). The facade builds a
headless agent lazily on first `run_turn`, binds the live tool registry, and honors the
`tools` allowlist — so the plugin calls `ctx.agent.run_turn(prompt, tools=REPLY_TOOLS,
memory_read=True, memory_write=True)` with **zero `luna.*` imports**. Signature is
byte-compatible with the plugin's call (verified). No plugin change required. Pulled
into the `luna/` submodule. Original analysis kept below for history.

---


The plugin's reply path:

```111:124:plugin-whatsapp/plugin_whatsapp/routes.py
        if ctx.agent is None:
            raise HTTPException(503, "agent not ready")

        rows = await db.recent_messages(ctx.engine, limit=80)
        context_block = build_context_block(rows, now=datetime.now(timezone.utc))
        prompt = _build_prompt(env, context_block)

        try:
            result, _usage = await ctx.agent.run_turn(
                prompt, tools=REPLY_TOOLS, memory_read=True, memory_write=True,
            )
```

But core **never sets `agent` on a `PluginContext`**:

- The dataclass field defaults to `None` and only a comment claims it is "set after
  agent init" (`luna/luna/plugins/context.py:51-53`).
- Both context construction sites in the loader — the `on_load` ctx
  (`luna/luna/plugins/loader.py:525-536`) and the **routes** ctx
  (`luna/luna/plugins/loader.py:662-674`) — do **not** pass `agent=`.
- A repo-wide search finds no writer of `PluginContext.agent` anywhere in core.
- The reference consumer, `plugin_playbooks`, does **not** rely on it: its runner
  **builds its own agent lazily** via `luna.agent.build_agent(...)` and caches it
  (`luna/plugins/plugin_playbooks/runner.py:420-483`). Its `on_load` reads
  `ctx.agent` (None) but the runner ignores that value.

**Consequence:** the WhatsApp inbound handler hits `ctx.agent is None` on every
message and returns 503. The capture + policy + context steps run, but **no reply is
ever generated or sent.** The end-to-end MVP ("one real reply on WhatsApp") fails.

**Why it can't be cleanly fixed in this repo alone:** the only way to obtain a
run-able agent today is `luna.agent.build_agent(...)` — a `luna.*` import. The plugin
is contractually **`luna_sdk`-only** (`vision/luna-integration.md`, and a
forbidden-import unit test guards it). `luna_sdk` exposes **no** agent / `build_agent`
/ `run_turn` (`luna/luna_sdk/__init__.py` `__all__`). So headless turns are simply
not on the SDK surface for an out-of-tree plugin.

**Fix (two parts):**

1. **Luna-core enabler (a PROPOSAL, not an edit here — `luna/` is read-only).**
   Add a sanctioned SDK path for a headless plugin turn. Preferred: populate
   `ctx.agent` (or add `ctx.run_turn(...)`) on plugin contexts after agent init, so
   `ctx.agent.run_turn` works the same for webhooks as the doc promises. Write this
   as `luna/plans/NNN-luna-service-whatsapp-agent-turn/…` (proposal doc only) and
   surface it to the Luna team. Until it lands, the plugin cannot do a headless turn
   the sanctioned way.
2. **Plugin interim (only if the user accepts a temporary SDK-boundary exception):**
   mirror `plugin_playbooks` — lazily `build_agent(tool_registry=ctx.tool_registry,
   identity=…)` and cache it. This **breaks** the `luna_sdk`-only rule and the
   forbidden-import test, so it must be a conscious, documented interim with the test
   updated/xfail'd and a TODO pointing at the enabler. Do **not** do this silently.

**Decision needed from the user:** wait for the core enabler (clean, correct), or
ship the interim `build_agent` shim now (fast, violates the boundary). Recommend the
enabler; use the shim only to demo.

### B2 — `wa_send` / `wa_react` use `policy="ask"`, which core doesn't recognize → they fire with NO approval ✅ FIXED

**Resolution:** In the `plugin-whatsapp/` submodule, both tools now use
`policy="prompt_always"` in `__init__.py` **and** `luna-plugin.toml`;
`vision/luna-integration.md` no longer lists `ask` as valid. Added
`tests/test_tool_policy.py` (regression guard: registered + toml policies must be in
`{auto_approve, prompt_first_time_only, prompt_always, block}`, and `wa_send`/`wa_react`
must not be `auto_approve`). ⚠️ The **in-tree `plugin/` copy still has the `ask` bug** —
see S1. Original analysis below.

---


Core's valid tool policies are `auto_approve | prompt_first_time_only |
prompt_always | block` (`luna/luna/plugins/base.py:24-30`). The dispatch gate only
prompts for `prompt_always` / `prompt_first_time_only`, blocks on `block`, audits
`auto_approve`, and **falls through on anything else**
(`luna/luna/agent/runtime.py:782,865,874`). The plugin declares:

```132:157:plugin-whatsapp/plugin_whatsapp/__init__.py
        _reg(
            ToolDef(
                name="wa_send",
                ...
                policy="ask",
                risk_level="medium",
                sensitive_args=["text"],
            ),
            _wa_send,
        )
```

`"ask"` matches no branch, so `wa_send` (and `wa_react`, also `"ask"`) **execute
without any owner approval and without an audit row** — an external WhatsApp send
fires silently. (`wa_send`/`wa_react` are excluded from the inbound `REPLY_TOOLS`, so
this only affects proactive sends from normal Luna chat — but there it's a real
send-without-consent bug.)

**Fix (plugin-side, cheap):** change both to `policy="prompt_always"` (or
`prompt_first_time_only`). Also fix `vision/luna-integration.md`, which wrongly lists
`ask` as a valid policy.

## Secondary issues (not MVP-blocking, fix alongside)

### S1 — Duplicate plugin source: `plugin/` (in-tree) AND `plugin-whatsapp/` (submodule)
Both now exist and will drift. Pick one home. Recommended: the submodule
`plugin-whatsapp/` is the canonical published unit; remove the in-tree `plugin/`
copy (or make it the submodule). Update `vision/codemap.md` and `render.yaml`/README
paths to match. **Ask the user before deleting** `plugin/` (they restored it on
purpose).

### S2 — Vault secret is unreadable as configured (env fallback masks it)
`client.py::shared_secret` reads vault key `plugin_whatsapp.shared_secret`
(`VAULT_SECRET_KEY`). `ScopedVault.get_credential` only auto-allows **self-owned**
keys, decided from the plugin's `credential_slots()`
(`luna/luna/providers/vault.py:326-335`, `_registry_slots_for`). The plugin declares
**no** `credential_slots()`, so the key isn't self-owned → ACL denies →
`PermissionError` → caught → falls back to env `LUNA_WHATSAPP_SHARED_SECRET`. So the
vault path never works; only the env var does. Fine for the MVP (set the env var),
but the "secrets from the vault" principle is unmet. **Fix:** declare a
`credential_slot` for the shared secret (and align the key name with the plugin
identity), or document env-only for v1.

### S3 — Group `chat_name` is always `null` from the gateway
`gateway/src/wa.js:100` sets `chat_name` to `null` for groups
(`kind === 'group' ? (message.pushName ? null : null) : …`). Cross-chat context then
attributes group messages by JID, not name — weakens the headline "what did I say in
group A" feature. **Fix:** resolve the group subject (e.g. `groupMetadata`/store) and
populate `chat_name`.

### S4 — `recall_conversation` in `REPLY_TOOLS` ✅ VERIFIED valid
`recall_conversation` is a real, shipped tool owned by the global `plugin_recall`
plugin (Luna Phase 008.002; `depends_on == []`, `policy=auto_approve`, no tables/routes).
Keeping it in `REPLY_TOOLS` is correct — it lets the WhatsApp reply turn fetch exact
earlier wording. No change needed (assuming `plugin_recall` is loaded, which it is by
default in core).

## Goals

1. Inbound DM/group-mention produces exactly one real Luna reply on WhatsApp.
2. `wa_send`/`wa_react` require owner approval (no silent external send).
3. One canonical plugin source; contract docs match reality.
4. Vault/secret story is either working or explicitly env-only for v1.

## Non-Goals

- Editing `luna/` code (read-only submodule; core changes go via a proposal).
- Multi-tenant (Phase 3), media, outbox/retry hardening (later roadmap phases).

## Approach (ordered)

1. **B1 decision** with the user: core enabler (proposal) vs. interim `build_agent`
   shim. If enabler: write `luna/plans/…` proposal doc (no code). If interim: add the
   shim in `routes.py`, cache it, update the forbidden-import test with a documented
   exception + TODO.
2. **B2:** flip `wa_send`/`wa_react` to `prompt_always`; fix the vision doc; add a
   manifest/policy unit test asserting no tool uses an unknown policy string.
3. **S1:** consolidate to the submodule; fix `vision/codemap.md`, README, `render.yaml`
   references. (Confirm deletion of in-tree `plugin/` with the user.)
4. **S2:** add `credential_slots()` for the shared secret, or document env-only.
5. **S3:** populate group `chat_name` in `gateway/src/wa.js`.
6. **S4:** verify/remove `recall_conversation`.
7. Bump plugin version in **both** `luna-plugin.toml` and `__init__.py`
   `PluginManifest` (0.1.0 → 0.2.0).

## Acceptance criteria

- [x] B1 fix in place (Luna `ctx.agent` facade) so the inbound path no longer 503s on
      `ctx.agent is None`. (Live "one reply on WhatsApp" still needs a QR scan + gateway.)
- [x] `wa_send`/`wa_react` use a real gating policy (`prompt_always`); guard test added.
- [ ] Only one plugin source exists — **pending user OK to delete in-tree `plugin/`** (S1).
- [x] `pytest -q` green (20 passed), including the new unknown-`policy` guard test.
- [ ] `hmac.js` ↔ `hmac.py` cross-language check (unchanged; run at deploy).
- [ ] Group messages carry a `chat_name` (S3) — deferred.

## Verification

```bash
# Plugin unit tests
cd plugin-whatsapp && uv venv --python 3.12 .venv && . .venv/bin/activate \
  && uv pip install -e ".[dev]" && pytest -q

# HMAC cross-language sanity (must print the same digest on both)
node -e "import('./gateway/src/hmac.js').then(m=>console.log(m.sign('shared','{\"x\":1}','1000').signature))"
python -c "import sys; sys.path.insert(0,'plugin-whatsapp'); from plugin_whatsapp.hmac import sign; print(sign('shared','{\"x\":1}','1000')[1])"

# Live: deploy gateway, scan QR, send an allowlisted DM, expect exactly one reply.
```

## Evidence index (file:line)

- Inbound depends on `ctx.agent`: `plugin-whatsapp/plugin_whatsapp/routes.py:111-124`
- `ctx.agent` default None + "set after init" comment: `luna/luna/plugins/context.py:51-53`
- Loader never sets `agent=`: `luna/luna/plugins/loader.py:525-536` and `:662-674`
- Playbooks builds its own agent instead: `luna/plugins/plugin_playbooks/runner.py:420-483`
- `run_turn` signature: `luna/luna/agent/runtime.py:1028`
- Dispatch gate policy handling: `luna/luna/agent/runtime.py:782,865,874`
- Valid policy values: `luna/luna/plugins/base.py:24-30`
- Plugin uses `policy="ask"`: `plugin-whatsapp/plugin_whatsapp/__init__.py:152,176`
- SDK exports (no agent/build_agent): `luna/luna_sdk/__init__.py` `__all__`
- Vault self-owned gate: `luna/luna/providers/vault.py:326-335`
- Group chat_name null: `gateway/src/wa.js:100`
