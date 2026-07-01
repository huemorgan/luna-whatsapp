# Luna integration reference (the plugin end)

> Everything the plugin depends on from Luna, so you can fix the plugin end
> without the Luna source in front of you. The plugin imports **`luna_sdk` only** —
> never `luna.*`. That rule is what keeps it portable and marketplace-installable.

## What a Luna plugin is

A Python package with a `LunaPlugin` subclass and a `luna-plugin.toml` data
manifest. Luna's loader discovers the class, reads the manifest, calls `on_load`,
and (if declared) mounts the plugin's HTTP routes. This plugin's package dir is
`plugin/plugin_whatsapp/` and its `entry` in the manifest is `plugin_whatsapp`.

## The `luna_sdk` surface we use

Imported in this plugin (all from `luna_sdk`):

```python
from luna_sdk import (
    LunaPlugin, PluginManifest, PluginContext, ToolDef, SettingsTab,
    declarative_base, UUID,   # plugin-owned tables (isolated metadata)
    # available but not all used: JSONB, SkillDef, get_current_user, CredentialSlot,
    # SettingsDef/Section/Field, TriggerInfo/TriggerSource, StorageProvider, AuthSpec/Connection
)
```

### `PluginManifest`
Declares identity + capabilities. Fields we set: `name`, `version`, `description`,
`category` ("connectors"), `depends_on` (`["plugin-vault"]`), `routes_module`
("routes"), `license`, `settings_tabs`. **Must stay in sync with
`luna-plugin.toml`** (name, version, tool list) — a mismatch is the #1 cause of
confusing installs.

### `LunaPlugin` lifecycle
- `async on_load(self, ctx: PluginContext)` — called once at load. We create our
  tables and register tools here.
- `async on_unload(self)` — cleanup (close clients). Optional.
- `async prompt_sections(self) -> list[str]` — strings injected into the agent's
  system prompt (also for `run_turn`). We use it for the WhatsApp capability note.

### `PluginContext` (`ctx`) — the runtime handle
Members this plugin relies on:

| Member | Type / shape | Used for |
|---|---|---|
| `ctx.engine` | SQLAlchemy `AsyncEngine` | our plugin-owned tables (create + read/write) |
| `ctx.agent` | agent handle, may be `None` early | `await ctx.agent.run_turn(...)` |
| `ctx.vault` | credential store (needs `depends_on=["plugin-vault"]`) | read the shared secret; `get_credential(key)` raises `KeyError` if absent |
| `ctx.get_env(name)` | `str | None` | read `LUNA_WHATSAPP_*` env |
| `ctx.tool_registry.register(plugin, ToolDef, handler, *, skill_gated=False)` | – | register the 5 `wa_*` tools |
| `ctx.conversations` | read-only reader (`list()`, `messages(...)`) | (available for future recall integration) |
| `ctx.current_conversation_id` | `uuid | None` | active conversation during a turn |
| `ctx.events.emit(name, payload)` | async | (available to publish `whatsapp.*` events) |
| `ctx.skill_registry.register(...)` | – | (available if we later gate tools behind skills) |

### `ctx.agent.run_turn(...)` — the agent call
```python
result, usage = await ctx.agent.run_turn(
    prompt: str,
    *,
    output_schema: dict | None = None,   # if set, agent returns JSON matching it
    tools: list[str] | None = None,      # ALLOWLIST of tool names; None = all non-gated
    identity: dict | None = None,
    memory_write: bool = False,          # persist new memories
    memory_read: bool = True,            # read recall context
)
```
- It is **headless**: no chat window, no streaming. `result` is the raw text
  (or a parsed dict if `output_schema` given).
- We pass an explicit `tools` allowlist that **excludes** `wa_send`/`wa_react` on
  the inbound path so the agent can't fire a second reply (the plugin sends the
  returned text deterministically). See [`architecture.md`](architecture.md).
- Known gap: `run_turn` does not persist into a named conversation or stream. The
  MVP is "v1" — `run_turn` + the plugin's own context store. A cleaner "v2" would
  be a core enabler to run a first-class conversation turn bound to a
  conversation_id. **That is a Luna-core change and must NOT be made in this repo**
  (see the luna-service AGENTS rule about the read-only `luna/` submodule).

### `ToolDef`
Fields: `name`, `description`, `parameters` (JSON schema), `policy`
(`auto_approve` | `ask` | `prompt_always`), `risk_level` (`low` | `medium` |
`high`), `sensitive_args` (kept out of logs), `chat_only`, `timeout_seconds`.
Convention: read = `auto_approve`/`low`; external write = `ask`/`medium`; delete or
secrets = `prompt_always`/`high`. Our tools:

| tool | policy | risk | note |
|---|---|---|---|
| `wa_context` | auto_approve | low | read cross-chat window; `sensitive_args=["body"]` |
| `wa_list_chats` | auto_approve | low | |
| `wa_status` | auto_approve | low | gateway health |
| `wa_send` | ask | medium | external side-effect; `sensitive_args=["text"]` |
| `wa_react` | ask | low | |

### Plugin-owned DB tables
```python
from luna_sdk import declarative_base, UUID
Base = declarative_base()          # isolated MetaData — never core's Base
class WhatsAppMessage(Base): ...    # our table
# in on_load:
async with ctx.engine.begin() as conn:
    for t in Base.metadata.sorted_tables:
        await conn.run_sync(t.create, checkfirst=True)
```
Reads/writes use SQLAlchemy Core on `WhatsAppMessage.__table__` over `ctx.engine`
(see `db.py`) to avoid ORM/async-session friction.

### HTTP routes
`routes_module="routes"` makes Luna import `plugin_whatsapp/routes.py` and call
`register_routes(app, ctx)`. We mount an `APIRouter(prefix="/api/p/plugin-whatsapp")`.
User-facing routes depend on `get_current_user`; the `/inbound` webhook is public
but HMAC-gated (the gateway is not a logged-in user).

## Conventions that are enforced (don't fight them)

1. **`luna_sdk` only.** No `import luna.*`. There's a unit test guarding this.
2. **Two manifests in sync.** `luna-plugin.toml` and `PluginManifest` must agree on
   name, version, and the tool list. When you add/remove a tool, update
   `[requires] tools = N`, the `[[tools]]` list, `WA_TOOL_NAMES` in `__init__.py`,
   and the toml — the `test_manifest.py` tests check this.
3. **Honest policy + risk per tool.**
4. **Secrets from the vault**, not hard-coded. `depends_on=["plugin-vault"]`.
5. **Published versions are immutable.** Any change ships as a new semver version
   (bump BOTH manifest files). Re-publishing the same `name@version` with different
   bytes is rejected.
6. **One top-level package dir per plugin zip**; `entry` matches that dir.

## How this plugin is installed / tested in a real Luna

- Drop `plugin/plugin_whatsapp/` into Luna's plugins directory (or package it and
  install from a marketplace), set the `LUNA_WHATSAPP_*` env, restart Luna.
- Unit tests don't need the Luna runtime: `plugin/tests/conftest.py` injects a tiny
  `luna_sdk` stub so the package imports; logic modules (`hmac`, `context`,
  `policy`) are pure and test directly. Run: `uv venv --python 3.12 .venv &&
  source .venv/bin/activate && uv pip install -e ".[dev]" && pytest -q`.
