# luna-whatsapp — Communication Vision

> How Luna should **talk**, **remember**, and **behave** on WhatsApp. This is the
> north star for the reply experience, the companion to [`vision.md`](vision.md)
> (the product) and [`contract.md`](contract.md) (the wire). Read it before you
> touch the reply path (`gateway/src/wa.js`, `plugin/plugin_whatsapp/routes.py`)
> or the WhatsApp persona.

## One sentence

On WhatsApp, Luna should feel like **a competent person texting you** — one
message, in your language, that answers the thing — never a bot that quotes every
line, thinks out loud, or double-texts.

---

## Why this doc exists (what went wrong)

Real transcript from the linked number (2026-07-02), lightly trimmed:

```
USER  (empty system message — WhatsApp protocol noise)
LUNA  (quoting)  "Nothing warranted — that's an empty system tag, not a real message from Roy."
LUNA  (quoting)  "yo! what's good?"
USER  (empty system message)
LUNA  (quoting)  "Nothing to reply to here -- that's an empty system tag, not a real message."
LUNA  (quoting)  "yep, right here. what do you need?"
LUNA  (quoting)  "yep, right here. what do you need?"        ← duplicate
LUNA  [other]    (empty message)
```

and earlier:

```
USER  "Ok"
LUNA  "He said \"Ok\" to my offer of a cat GIF. I need to send him one, but I
       don't have GIF tools available in this WhatsApp-only context. I should
       let him know I'll send it from the web chat side... Sending it — one sec."
LUNA  "I don't have the GIF tools available from WhatsApp right now either..."
LUNA  "I only have read-only WhatsApp tools here... No additional reply needed."
```

Five distinct failures, and they're the whole reason for this vision:

1. **Reflexive quoting.** Almost every reply "quotes" the user's message. In a 1:1
   thread that is robotic — people don't reply-quote every line.
2. **Multiple messages per turn**, sometimes **byte-for-byte duplicates**.
3. **Internal reasoning leaks** as a message ("He said Ok… I need to… I should
   let him know…"). That is chain-of-thought, not a reply.
4. **Meta-commentary** about the trigger ("that's an empty system tag", "No
   additional reply needed") sent *to the user*.
5. **Replying to nothing.** Empty `system`/protocol frames are forwarded and
   answered; the agent even emits empty `[other]` messages.

None of these are the model being "dumb." Each traces to a concrete seam in the
pipeline (below). Fixing the seam — not scolding the prompt — is the rule
(`.cursor/rules/fix-capability-not-prompt.mdc`).

---

## Part 1 — How Luna communicates (the style contract)

This is the "skill": not a `load_skill` skill (those are `skill_gated` and get
filtered out of a headless `run_turn`), but a **behavior contract baked into
every WhatsApp reply turn** — via the plugin persona and the system-prompt
sections the plugin injects. It must hold on every turn without the model having
to opt in.

**The contract, in priority order:**

1. **You are the message.** The text you return *is* the WhatsApp message the
   user sees. Not a draft, not a note, not a step result. Write it as the final
   thing a person reads. Never narrate your plan, your tools, or your
   constraints. No "I should…", no "Nothing to reply to", no "No reply needed".
2. **Exactly one message per turn.** One inbound → one outbound (plus at most one
   media attachment when media was asked for). If you're tempted to send two
   bubbles, merge them or pick the one that matters.
3. **Don't reply-quote by default.** In a 1:1 DM, just talk — no quoted context.
   Quote *only* when it removes real ambiguity: in a busy group, or when
   answering a specific older message after other traffic.
4. **Mirror the user's language and register.** They wrote Hebrew → answer in
   Hebrew. They wrote one terse line → don't send a paragraph. Match tone
   (casual/formal) and length to theirs.
5. **Texting cadence, not essay cadence.** Short sentences. No markdown headers,
   no bullet dumps, no walls. Emojis only if they use them.
6. **In groups, be a guest.** Answer only what you were addressed for; never
   dominate; don't recap the whole thread.
7. **Media is native.** To send an image/GIF/file, deliver it as media (see
   [`contract.md`](contract.md) `/send-media`), not as a raw URL pasted in text.
8. **Truth about actions.** Never claim you sent, saved, or did something unless
   the tool acked it. If a capability genuinely isn't available, say the useful
   half ("want me to find a GIF instead?") — don't explain your internal tooling.
9. **Silence is a valid reply.** If nothing was actually said to you (protocol
   noise, an overheard group line you weren't addressed for), send nothing.

**Voice-note principle (near-term):** WhatsApp is a voice-first channel for many
people. Short spoken replies (TTS voice notes) are a first-class output, not an
afterthought — see [`roadmap.md`](roadmap.md). The same one-message, mirror-their-
language rules apply.

---

## Part 2 — How Luna saves data (the memory contract)

Communication quality depends on remembering the right things and forgetting the
rest. Two stores, one source of truth:

1. **Gateway Postgres (`whatsapp_messages`) — the source of truth.** 100% of
   inbound *and* outbound is written here *before* any decision, idempotent on
   `wa_msg_id`. A restart on either end replays from here. This is capture, not
   interpretation — it stores everything, including protocol frames and media
   pointers.
2. **Plugin store (`whatsapp_plugin_messages`) — the agent's context window.** A
   curated, owner-global slice used to build the cross-chat context block (last
   ~5 min / 30 messages, attributed by chat + sender + time). This is what makes
   "you said X in group A" work in group B — the headline feature.

**Principles:**

- **Capture raw, feed clean.** The gateway captures everything; the plugin store
  should hold *conversational* messages, not empty system/protocol frames or the
  agent's own non-answers. Garbage in the context window becomes garbage in the
  reply (it's part of why the agent "replied to an empty tag").
- **Attribution is mandatory.** Every remembered line carries who said it, in
  which chat, when. Cross-chat recall without attribution would leak or confuse.
- **Never leak across chats.** Context may *inform* a reply, but private content
  from chat A must never be quoted verbatim into chat B. Owner-global memory is a
  convenience for the owner, not a broadcast channel.
- **Store outbound as first-class.** Luna's own replies are memory too, so it
  doesn't repeat itself or contradict what it just said.
- **What not to store in the context window:** empty bodies, presence/receipts,
  the agent's internal reasoning, and anything the agent decided *not* to send.
- **Retention & privacy (direction):** the owner can see and purge what's stored;
  media beyond capture (transcription/vision) is a later phase; nothing leaves the
  owner's own Luna. (Multi-tenant isolation is luna-service's problem — see
  [`roadmap.md`](roadmap.md).)

---

## Part 3 — How Luna behaves (the decision contract)

**When to answer at all** (unchanged from `vision.md`, tightened):

- **DM:** answer if the sender is allowlisted. Everything else is captured, not
  answered.
- **Group:** answer only on @mention or a reply to Luna's own message. Ordinary
  chatter is remembered, never answered.
- **Never answer:** empty bodies, `system`/protocol frames, receipts, presence,
  your own echoes (`from_me`). These should be *filtered before the agent ever
  runs* — the agent should not be asked "should I reply to this?" about a frame
  that isn't a message.

**The headless-turn pitfall (important, and the root of the reasoning leaks).**
Luna core's `run_turn` appends: *"You are running as a background step (no chat
window). Plain text you output is only stored as the step result — the owner does
NOT see it. To tell the owner something, call `send_chat_message`."* On WhatsApp
that instruction is **actively wrong**: we *do* send the returned text, and
`send_chat_message` writes into a *web* conversation the WhatsApp user will never
see. That contradiction is what makes the model write "No additional reply
needed" and narrate its plan. The WhatsApp reply turn must **override** it: *your
returned text IS the message the user sees; there is no other channel; do not call
`send_chat_message`.* (Longer-term, Luna core should let a caller declare the turn
"user-facing" — see the proposal in `plans/002-whatsapp-full-parity/`.)

**One inbound → one reply, deterministically.** The plugin owns delivery: it sends
the turn's final text (plus referenced media) exactly once. The agent does not get
`wa_send`/`wa_react` on the reply turn (they'd double-post and bypass approval).
Duplicate identical bubbles are a bug in the pipeline, not a style choice — guard
against them.

**Full capability, WhatsApp-shaped output.** WhatsApp is a first-class channel
with the *entire* toolkit (web, files, memory, connectors, screenshots, GIFs) —
never "go to the web app." Capability is unlimited; *presentation* is
WhatsApp-native (short, one message, media delivered natively).

**Fail like a person.** Tool down? Offer the useful alternative in one line. Don't
expose stack traces, tool names, or "this context." Don't apologize in a loop.

---

## The bridge to implementation (what this vision implies)

This doc is the target; these are the seams it says to fix (design only — see the
plan when we execute):

| # | Seam | Where | Change the behavior implies |
|---|------|-------|------------------------------|
| A | Protocol noise reaches the agent | `gateway/src/wa.js` (and/or `policy.py`) | Drop empty-body / `system` / receipt / presence frames before forwarding; never forward a non-message. |
| B | Reflexive quoting | `plugin/plugin_whatsapp/routes.py` | `reply_to` only in groups or on genuine ambiguity; DMs send unquoted. |
| C | Reasoning/meta leaks | WhatsApp persona + turn-prompt override | Explicitly override the "background step / not seen" instruction; forbid meta and planning in output. |
| D | Multiple/empty sends | `routes.py` | Exactly one text send; skip empty/whitespace/meta-only output; de-dupe. |
| E | Context polluted by noise | plugin store write path | Don't persist empty/system/agent-non-answers into the context window. |
| F | Language mirroring | persona | Instruct: answer in the user's language and register. |

Each of A–F maps to one of the five observed failures. Implementing them is the
"WhatsApp communication skill" made real — a behavior contract enforced by the
pipeline and the persona, not left to the model's discretion.

## What "good" sounds like (success)

```
USER  "אני נוסע לשדה בוקר היום וצריך לאכול בדרך ארוחת ערב..."
LUNA  "בדרך לשדה בוקר עצור במצפה רמון — 'הַכי בעיר' פשוט וטעים, או המאפייה
       בקיבוץ שדה בוקר אם בא לך משהו קליל. שניהם על הציר ולפני 8."
```

One message. Their language. Answers the thing. No quote, no preamble, no "I
searched the web and found…". That's the bar.
