# Dojo conversation tests (WhatsApp bridge)

Pure **dojo-style** tests: each scenario is a real conversation plus a plain-English
description of what a *good* reply looks like. We send the message through the real
bridge, let the real Luna agent answer, and an **LLM judge** reads the reply against
the rubric and decides pass / partial / fail. No brittle string assertions.

## What a scenario looks like

`conversations/NN-name.md` has two parts:

- a ```` ```json ```` block — the turn(s) to send (the machine part), and
- a `## Expect` section — prose describing the reply we want to see, including a
  "must NOT" list (leaked reasoning, meta narration, punting to the web app, …).

Turn fields: `chat` (`self` or a group label) or explicit `jid`, `kind`
(`dm`/`group`), `text`, `mentioned` (group @mention), `plant` (seed a message into
another chat's history without sending — for cross-chat recall), `judge` (the turn
whose reply is captured and graded).

## How it runs

`run_dojo.py`:
1. HMAC-signs each turn and POSTs it to the running plugin's `/inbound` (identical
   to what the gateway does).
2. Reads Luna's actual reply from the plugin store (`whatsapp_plugin_messages`,
   `from_me=true`), including any media rows.
3. Sends the message + reply + rubric to the judge (`claude-sonnet-4-6`) → JSON
   verdict.
4. Writes `RESULTS.md`.

Replies are delivered for real to the linked WhatsApp number (the owner's own
chat), so this exercises the full path end-to-end.

## Prerequisites

- Luna running on `localhost:3000` with the whatsapp plugin loaded.
- Gateway running and WhatsApp linked (`GET /health` → `connected:true`).
- `gateway/.env` has `WA_SHARED_SECRET` + `DATABASE_URL`; `luna/.env` has
  `LUNA_ANTHROPIC_API_KEY` (judge).

## Run

```bash
cd tests/dojo
python3 run_dojo.py            # all scenarios
python3 run_dojo.py 04 06      # only ids containing 04 / 06
```

Results land in `tests/dojo/RESULTS.md`.

## Findings from the first run (and fixes)

Baseline on the live agent was **6/9**. The suite surfaced three genuine issues
(the rest were harness bugs in the runner, since fixed — a watermark that
truncated Postgres microseconds and a missing `created_at` on planted rows):

| Issue | Scenario | Root cause | Fix |
|---|---|---|---|
| Fabricated a fake news headline instead of searching | 04 | `web_search` exists and works (Tavily 200; giphy tool-calls prove `run_turn` executes tools) — the model just answered from stale memory | Persona now has a **hard grounding rule**: current-events/news/prices/"today" questions MUST call `web_search` first and answer only from results; never invent headlines/sources/numbers |
| Meta-narrated the empty message ("nothing to reply to here") | 09 | Plugin ran a full turn on an empty-bodied event, handing the agent a `<text>` placeholder that invited meta | Plugin now treats an empty/whitespace text body as protocol noise — records it for context but stays silent (`reason=empty_inbound`) |
| False "I already sent you this" narration | 02 | Model narrated conversation history | Persona now forbids narrating the chat/history and says to answer the current message only |

After fixes: **8/9**. The remaining PARTIAL on 02 is a *test artifact* — the same
Hebrew question was sent ~5×, so the agent correctly recalls it answered before.
On a fresh question the reply is clean (verified).

Grounding (04) is now enforced but still stochastic (PASS/PARTIAL across runs)
because forcing tool use is a Luna-core concern the plugin can only nudge. The
capability itself is proven working.

All fixes live in the `plugin-whatsapp/` submodule (source of truth), synced to
`~/.luna/managed_plugins/plugin_whatsapp/` (what Luna loads). The in-tree
`plugin/` copy is stale and unused.
