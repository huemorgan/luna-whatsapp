# Proposal to Luna core — headless turns need artifacts, chat_only opt-in, and skills

**From:** luna-whatsapp (plugin-whatsapp)
**Why:** WhatsApp reaches ~90% parity with the web app today by unlocking the
full toolkit on the reply turn. The remaining gap is entirely in `run_turn`
(the `PluginAgent` facade). Three additive changes in `../luna` close it. This
doc is a recommendation — per repo rules we do **not** edit `../luna` from here.

Everything below was verified against the current `luna/luna/agent/runtime.py`
(`LunaAgent.run_turn`) and `luna/luna/plugins/agent_facade.py`.

---

## Context: what a plugin can and cannot get today

A plugin runs a headless turn via `ctx.agent.run_turn(prompt, tools=…)`. Reading
the current runtime, three limits block full parity:

1. **Tool artifacts are dropped.** In `run_turn` the per-tool wrapper stringifies
   the result and feeds it back to the model, but returns only the model's final
   **text** to the caller:

   ```python
   # runtime.py ~L1146
   return result if isinstance(result, str) else _json.dumps(result, default=str)
   ```

   So when a tool produces an image/gif/file (an embed or asset URL), the plugin
   never sees it — only whatever URL the model happens to echo into its prose.
   WhatsApp media delivery today relies on that echo (best-effort URL scraping).

2. **`chat_only` tools are hard-filtered even from an explicit allowlist.**

   ```python
   # runtime.py ~L1128
   if rt.definition.chat_only:
       continue
   ```

   Playbook tools (`playbook_run`, etc.) are `chat_only=True`, so a WhatsApp turn
   can never *run* a playbook, only describe one. Same for anything a plugin
   marked chat_only to avoid recursion in the web chat.

3. **`skill_gated` tools are filtered too**, so skills that gate tools aren't
   reachable from a headless turn.

Also note: `run_turn` does **not** enforce tool approval policy (the wrapper
calls the handler directly). That's why plugin-whatsapp must *exclude*
`wa_send`/`wa_react` from the reply turn rather than rely on `prompt_always`.

---

## Change 1 (highest value) — surface tool artifacts from `run_turn`

**What:** let a caller opt into receiving the structured tool results/artifacts
produced during the turn, without changing the default return shape.

**Proposed surface (additive):**

```python
async def run_turn(
    self, prompt, *, output_schema=None, tools=None, identity=None,
    memory_write=False, memory_read=True,
    return_artifacts: bool = False,      # NEW
) -> tuple[dict | str, RunUsage] | tuple[dict | str, RunUsage, list[ToolArtifact]]:
    ...
```

where `ToolArtifact` is a small dataclass already implied by the embed system:

```python
@dataclass
class ToolArtifact:
    tool: str
    kind: str            # "image" | "video" | "audio" | "file" | "embed" | "data"
    url: str | None      # public or internal asset URL
    mime: str | None
    bytes_b64: str | None  # for internal assets not reachable by URL
    meta: dict           # embed_html/embed_iframe/etc.
```

**How:** the per-tool wrapper already has the raw result. When a tool returns a
dict carrying `embed_html`/`embed_iframe`/`url`/`file_id`, collect a
`ToolArtifact` into a per-run list (in addition to stringifying for the model).
Return the list when `return_artifacts=True`.

**Impact on plugin-whatsapp:** replaces the best-effort URL scraper in
`media.py` with exact, reliable media delivery for **every** media-producing
tool (giphy, browser screenshots, generated files, future image-gen), including
internal assets via `bytes_b64`.

---

## Change 2 — `chat_only` → an explicit headless opt-in

**Problem:** `chat_only=True` currently means two different things: "don't
recurse in chat" AND "never available headless." Playbooks want the first, not
the second.

**Proposed:** add `headless_allowed: bool = False` to `ToolDef`. In `run_turn`,
replace the blanket `chat_only` skip with:

```python
if rt.definition.chat_only and not rt.definition.headless_allowed:
    continue
```

Plugins that are safe to run headless (playbooks, once they guard their own
recursion) set `headless_allowed=True`. Default behavior is unchanged.

**Impact:** unlocks "create/run a playbook from WhatsApp" — the exact thing the
agent currently refuses ("I don't have access to the playbook-building tools
from WhatsApp right now").

---

## Change 3 — skills in `run_turn`

**Problem:** `skill_gated` tools are filtered unconditionally.

**Proposed:** allow a caller to pass an active-skills set (or reuse the owner's
enabled skills) so a headless turn can load a skill and use its gated tools,
mirroring the chat path. Lower priority than 1 & 2.

---

## Suggested rollout in `../luna`

1. `plans/009-plugin-run-turn-artifacts/` — implement Change 1 (artifacts).
2. Follow with Change 2 (`headless_allowed`) — tiny, high value for playbooks.
3. Change 3 last.

Each is additive and backward-compatible: existing `run_turn` callers keep the
2-tuple text return and today's filtering. plugin-whatsapp adopts them behind a
version check on the SDK.
