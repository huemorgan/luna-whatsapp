# 005 — WhatsApp full control (execution summary)

**Shipped:** plugin-whatsapp **v0.10.0** + gateway group/resolve endpoints.

## Why

1. Private sends failed: `wa_send` was excluded from WhatsApp reply turns
   (`_REPLY_TOOL_EXCLUDE`), so "message Nadav for me" — asked over WhatsApp —
   always failed ("the send tool got dropped from this run's toolkit"). It also
   required an exact `chat_jid`; there was no phone-number or name resolution
   anywhere.
2. The agent had no group tools (rename, members, create, leave, invite).
3. All five tools + a long capability note sat in the main prompt (bloat).

## What shipped

### Gateway

- `normalizeTarget` / `Session.resolveJid`: any of JID / phone number (any
  human format) / group JID resolves to a canonical JID; bare numbers verified
  with `onWhatsApp` (404 `not_on_whatsapp` for unregistered). Applied to
  `/send`, `/send-media`, `/react`.
- New HMAC endpoints: `/resolve`, `/groups/{list,info,subject,participants,
  create,leave,invite}` (all POST so the HMAC covers the body). Errors carry
  `e.status || 502`. Dry-mode (`WA_DRY_SEND=1`) fakes for all of them.
- `shapeGroupMeta` exposes participants + admin roles + `me_admin`;
  `groupRename` busts the group-name cache.

### Plugin (0.10.0)

- **14 tools.** Always-on daily drivers: `wa_send`, `wa_react`. Skill-gated
  (006.0 hybrid, L143): `whatsapp` skill → `wa_send_media`, `wa_context`,
  `wa_list_chats`, `wa_status`, `wa_resolve`; `whatsapp-groups` skill →
  `wa_list_groups`, `wa_group_info`, `wa_group_rename`, `wa_group_members`,
  `wa_group_create`, `wa_group_leave`, `wa_group_invite`.
- `wa_send` rebuilt: `to` accepts phone number / exact chat name (plugin-DB
  lookup, unique match required) / JID; keeps a hidden `chat_jid` alias.
  Records its own sends to the plugin store.
- Reply turns: `_REPLY_TOOL_EXCLUDE` shrank to `{"send_chat_message"}` —
  `wa_send`/`wa_react` now available in WhatsApp turns. Double-posting into
  the current chat is prevented by a contextvar guard
  (`state.current_inbound_chat`, set around `run_turn`).
- Fallback: no `SkillDef`/`skill_registry` → everything registers always-on
  (capability never disappears).
- `_CAPABILITY_NOTE` slimmed to a pointer at the skills.

### Not done here (proposal written instead)

`run_turn` skips skill-gated tools even when explicitly allowlisted, so gated
tools can't fire on reply turns until core changes — see
`luna-core-proposal.md` (one-line fix; `_reply_tools` is already forward-
compatible).

## Tests

Gateway `node --test`: 49 pass. Plugin pytest: 106 pass (new:
`test_skills.py`, `test_target_resolution.py`).
