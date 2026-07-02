---
name: devprocess
description: >-
  Numbered feature delivery workflow: plan in plans/NNN-name/PLAN.md, implement,
  add tests in tests/NNN-name/, write execution report. Use when the user says
  $devprocess, devprocess, numbered plan, execution report, or wants a full
  feature slice from spec through verification.
---

# Devprocess — Numbered Feature Delivery (luna-whatsapp)

Deliver one feature slice end-to-end: **plan → implement → test → report**.

This repo has **two ends** (see `vision/architecture.md` and `vision/codemap.md`):
the **gateway** (`gateway/`, Node + Baileys) and the **Luna plugin**
(`plugin/plugin_whatsapp/`, Python). They meet at exactly one boundary — the wire
contract in `vision/contract.md`. **Any change to a message that crosses that
boundary is a change to BOTH ends in the same commit** (and to `vision/contract.md`).

## When to use

- User invokes `$devprocess`, `devprocess`, or asks for a numbered plan + tests + report
- Starting a new feature that should leave durable artifacts for the next agent/human
- Finishing a feature and need a structured execution report

## Numbering

1. List existing `plans/` folders matching `NNN-*` (three-digit prefix). If `plans/`
   does not exist yet, this is `001`.
2. Pick **next** `NNN` (e.g. if `002-*` exists, use `003`).
3. Use the **same** `NNN` and slug everywhere:
   - `plans/NNN-short-slug/PLAN.md`
   - `tests/NNN-short-slug/` (specs + `report.md`)

Slug: lowercase, hyphenated, short (`group-debounce`, not `GroupDebounce`).

**Note:** Plan numbers are independent of DB migration numbers, branch names, or PR numbers.

## Phase 0 — Architecture sync (BEFORE PLAN.md)

The `vision/` docs are the source of truth. Read the relevant ones before drafting
any plan:

- `vision/vision.md` — the north star (product principles, non-negotiables)
- `vision/architecture.md` — topology, data flow, sequences, failure modes
- `vision/contract.md` — the gateway↔plugin wire contract (the "both ends" doc)
- `vision/luna-integration.md` — the `luna_sdk` surface the plugin depends on
- `vision/roadmap.md` — phases, known gaps, acceptance criteria
- `vision/codemap.md` — where every file lives and which end it belongs to

For every plan, classify each change you intend to make:

| Class | Meaning | What to do |
|---|---|---|
| **ALIGNED** | Plan implements something the vision docs already specify | Cite the section. Proceed. |
| **ADD** | Plan introduces something the vision docs don't cover (new endpoint, new contract field, new tool, new gate) | Note in PLAN.md under `## Architecture impact`: `ADD: <one-line summary> → vision/<doc>.md § <target section>`. After execution, Phase 5 must update the vision doc. |
| **CONFLICT** | Plan changes a decision the vision docs already record (contract shape, HMAC scheme, one-socket-owner rule, capture-100% rule, activation policy) | **STOP. Do not draft PLAN.md.** Surface the conflict to the user with: (a) the vision section that conflicts, (b) the proposed change, (c) at least two alternatives, (d) ask which to choose. Only resume after the user picks; record the chosen path + rationale in PLAN.md and queue the vision-doc update for Phase 5. |

Skip Phase 0 only if the change is a pure bugfix or test-only and touches nothing
architecturally meaningful (no new contract field, no new endpoint, no new tool, no
schema change, no change to the HMAC scheme or activation policy).

## Phase 1 — Plan (`PLAN.md`)

Create `plans/NNN-short-slug/PLAN.md` **before** substantial code changes.

### Required sections

```markdown
# NNN — Human Title

**Produces version:** 0.M.P   (or `none` for docs-only plans)

## Context
Why now. What exists today. Pain or gap.

## Architecture impact
For each architectural change in this plan, list one of:
- `ALIGNED: <change> → vision/<doc>.md § <section>` (no vision update needed)
- `ADD: <change> → will add to vision/<doc>.md § <target section>`
- `CONFLICT (resolved): <change> → user chose <path> on <date>; see Decisions below`

If every change is ALIGNED with no ADDs, write "None — fully aligned with current
architecture." Skip the section only if Phase 0 marked the work as architecturally
insignificant (pure bugfix / test-only).

## Both-ends checklist
Does this change cross the gateway↔plugin boundary (vision/contract.md)?
- If yes: list the gateway files AND the plugin files that change together, and
  confirm `hmac.js` / `hmac.py` stay byte-identical.
- If no: state "single-end change (gateway only | plugin only)".

## Concerns Review
Read `vision/vision.md` "Product principles (the non-negotiables)" and list how this
feature satisfies each relevant one (100% capture, one socket owner, signed on every
hop, cross-chat memory, answer with judgment, WhatsApp-native voice, platform risk,
`luna_sdk`-only on the plugin side).

## Goals
Numbered outcomes.

## Non-Goals
Explicit out-of-scope items.

## Approach
Phased steps: contract → gateway → plugin → tests → verification.
Include file paths when known. Prefer extending existing modules over new abstractions.

## Data / API contract
Schemas, JSON shapes, envelope/response changes — anything both ends must share.

## Risks
Known failure modes and mitigations.

## Acceptance criteria
Checklist of done conditions.

## Verification
Exact commands to run (unit tests, HMAC cross-language check, manual round-trip).
```

### Plan quality bar

- **Actionable:** another agent can implement without guessing intent
- **Scoped:** one coherent feature, not a quarter roadmap
- **Honest:** call out demo-only paths, feature flags, local-only modes
- **Safe migrations:** never drop captured messages; the gateway store is the source
  of truth (append-only, idempotent on `wa_msg_id`)

## Phase 2 — Implement

1. Work on a focused branch (name ≈ slug).
2. Match project conventions (read surrounding files first).
3. **Minimize scope** — only what the plan requires.
4. If plan assumptions were wrong, **update PLAN.md** with a short "Plan amendments"
   note rather than silent drift.
5. **Both ends together.** If you touched the contract, edit the gateway file and the
   plugin file and `vision/contract.md` in the same commit. Re-run the HMAC
   cross-language check.

### Common layers (adapt to project)

| Layer | Typical artifacts |
|-------|-------------------|
| Contract | `vision/contract.md` + both `hmac.*` + envelope in `gateway/src/*` and `plugin/plugin_whatsapp/*` |
| Gateway | `gateway/src/*.js` (wa, db, inbound, index, config) |
| Plugin | `plugin/plugin_whatsapp/*.py` (routes, client, db, context, policy, __init__) |
| Tests | see Phase 3 |

## Phase 3 — Tests

Create `tests/NNN-short-slug/` alongside implementation.

### Choose test type

| Type | When |
|------|------|
| **Plugin unit** (`pytest`, in `plugin/tests/`) | Pure logic (hmac, context, policy), manifest sync, forbidden-import guard, contract-shaped envelope tests |
| **Contract-shaped** | Feed an inbound envelope, assert the decision/output — cheap and preferred |
| **Manual integration** | Live round-trip: real Luna + deployed gateway + a scanned number, walking the acceptance list |

Prefer a contract-shaped unit test (feed an envelope, assert the decision/output)
before wiring the live path.

### Regression

After adding a suite, re-run the full plugin unit suite (`pytest -q` in `plugin/`) if
the feature touched shared surfaces (hmac, context, policy, manifest). Record counts
in the report.

## Phase 4 — Execution report

Create `tests/NNN-short-slug/report.md` when implementation is done (pass or blocked).

### Report template

```markdown
# NNN — Human Title — Execution Report

**Branch:** `branch-name` (if applicable)
**Plan:** [`plans/NNN-short-slug/PLAN.md`](../../plans/NNN-short-slug/PLAN.md)
**Tests:** X/Y new · regression summary if run

---

## What was built
Bullets by end (gateway, plugin, contract).

## Contract / schema changes
Envelope fields, endpoints, DB columns — or "None (single-end change)".

## Files
**New:** list paths
**Modified:** list paths (note gateway+plugin pairs when the boundary moved)

## Test results
​```
paste command output or summary
​```

## Issues encountered & resolved
Non-obvious bugs, reverted approaches, env quirks.

## Concerns checklist
Map back to Concerns Review — ✓ or explain gap.

## Version
start version → end version (both manifests).

## Remaining / blocked
Only if something failed acceptance criteria.
```

## Phase 5 — Verify & close

Run everything listed under **Verification** in the plan. Typical for this repo:

```bash
# Plugin unit tests
cd plugin && uv venv --python 3.12 .venv && source .venv/bin/activate \
  && uv pip install -e ".[dev]" && pytest -q

# Gateway sanity (if touched)
cd gateway && npm ci && node -e "require('./src/hmac.js')"  # or npm test if present
```

- All acceptance criteria met → report documents pass
- Blocker remains → report documents blocker; do not claim done
- Do **not** commit unless the user asks

### Vision-doc sync (mandatory if Phase 0 found ADD or CONFLICT)

If the plan's `## Architecture impact` listed any `ADD` or `CONFLICT (resolved)`,
**before closing**:

1. Edit the target `vision/*.md` section(s) so a fresh reader gets the truth (don't
   just append a banner). If the boundary moved, update `vision/contract.md`.
2. Mark or delete anything now deprecated; don't leave both versions visible.
3. Note the vision update in the execution report under `## Architecture changes`.
4. Anything you couldn't reconcile → list under `## Remaining / blocked`.

A plan that says "ADD" in PLAN.md but ships with the vision docs unchanged is **not** done.

### Version bump (mandatory unless plan is `Produces version: none`)

The plugin version lives in **two files that must agree**:
`plugin/plugin_whatsapp/luna-plugin.toml` (`version = "..."`) and the
`PluginManifest` in `plugin/plugin_whatsapp/__init__.py` (`version="..."`). The
`test_manifest.py` tests check they match. If the plugin's public surface (tools,
routes, contract) changed, bump **both** to the plan's `Produces version`. If only
the gateway changed, bump `gateway/package.json` instead.

A plan with `Produces version: 0.M.P` that ships without bumping the version is **not**
done. Docs-only plans (`Produces version: none`) skip this step.

## Project adapters (read when present)

| Path | Use |
|------|-----|
| `vision/vision.md` | Product principles / non-negotiables → Concerns Review |
| `vision/architecture.md` | Topology, sequences, failure modes → Phase 0 |
| `vision/contract.md` | The gateway↔plugin treaty → both-ends checklist |
| `vision/luna-integration.md` | The `luna_sdk` surface the plugin may use |
| `vision/roadmap.md` | Phases + acceptance criteria |
| `vision/codemap.md` | File locations, "if I change X, which files?" |
| `.cursor/rules/*.mdc` | Tone (caveman), plan-before-execute, browser control, version bump |

## Anti-patterns

- Skipping Phase 0 vision-doc sync and starting PLAN.md cold
- Marking a CONFLICT as ALIGNED to avoid the user-decision step
- Touching one side of the contract without the other (401s / dropped messages)
- Re-serializing the body before HMAC verify instead of using the raw bytes
- Adding `wa_send`/`wa_react` to the inbound turn's tool allowlist (double reply)
- Skipping PLAN.md and coding first
- Mismatched `NNN` between `plans/` and `tests/`
- Empty report or report before any verification attempt
- Dropping/rewriting captured messages instead of additive, idempotent handling
- Plan ships with `## Architecture impact: ADD` but the vision doc is unchanged
- Plan declares a `Produces version` but the two plugin manifests weren't bumped/kept in sync

## Quick checklist

```
- [ ] Phase 0: relevant vision/*.md read; changes classified ALIGNED/ADD/CONFLICT
- [ ] CONFLICTs surfaced + resolved with user before drafting PLAN.md
- [ ] Next NNN chosen; slug consistent
- [ ] plans/NNN-slug/PLAN.md written (Architecture impact + Both-ends + Concerns Review)
- [ ] PLAN.md `Produces version:` line set (or `none`)
- [ ] Feature implemented per plan; both ends moved together if the contract changed
- [ ] hmac.js / hmac.py still byte-identical (re-ran cross-language check)
- [ ] tests/NNN-slug/ added; plugin pytest suite run
- [ ] tests/NNN-slug/report.md complete with real results
- [ ] vision/*.md updated for every ADD / CONFLICT change
- [ ] Version bumped in BOTH plugin manifests (or gateway/package.json)
- [ ] Acceptance criteria checked off
```
