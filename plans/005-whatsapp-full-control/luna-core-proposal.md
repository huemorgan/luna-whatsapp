# Luna-core proposal: honor explicit allowlists for skill-gated tools in `run_turn`

> Proposal only — per repo rule, Luna-core changes are never made from this
> repo. This documents the one-line core change that would let headless
> channel turns (WhatsApp replies) use skill-gated tools.

## Problem

`run_turn` (luna/luna/agent/runtime.py:1122-1131) skips `skill_gated` tools
unconditionally — **before** checking the caller's explicit `tools=[...]`
allowlist:

```python
if rt.skill_gated:
    continue
if allow is not None and rt.definition.name not in allow:
    continue
```

Consequence: a plugin that follows 006.0 and gates its tools behind skills can
never expose those tools on a headless turn, even when it deliberately
allowlists them. There is no `load_skill` in a single-shot `run_turn`, so the
gate is unliftable there.

plugin-whatsapp 0.10.0 works around this with the 006.0 hybrid (L143): the two
daily-driver tools (`wa_send`, `wa_react`) register always-on, twelve more are
skill-gated. Fine for now, but any connector with a headless inbound path will
hit the same wall, and the workaround pressure is always "make more tools
always-on", which defeats skill-gating.

## Proposed change (one line)

Treat an explicit allowlist as intent — the caller has already decided which
tools this turn gets, which is exactly the decision `load_skill` would make:

```python
if rt.skill_gated and (allow is None or rt.definition.name not in allow):
    continue
```

- `tools=None` (chat default): unchanged — skill-gated tools stay hidden until
  `load_skill`.
- `tools=[...]` including a gated name: the tool participates in that turn.

## Safety

- No approval-policy regression: `run_turn` already doesn't enforce dispatch
  gates; callers that allowlist a tool today already accept that. The change
  adds no new bypass — it only widens which *names* an explicit allowlist can
  select.
- No prompt-bloat regression: chat turns pass `tools=None` and are unaffected.

## Consumer already in place

`plugin_whatsapp/routes.py::_reply_tools` builds the reply-turn allowlist from
the full registry (minus `send_chat_message`). Today core silently drops the
skill-gated WhatsApp tools from that list; the moment core ships this change,
media + group tools light up on WhatsApp reply turns with **no plugin change**.
