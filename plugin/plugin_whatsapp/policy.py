"""Activation policy (pure, no luna_sdk).

DMs: answer if sender is in the allowlist (empty allowlist = answer all DMs, for
single-owner MVP testing). Groups: require an @mention or a reply-to-bot; other
group messages are still captured (100%) and feed context, they just don't
trigger a reply. See plans/whatsapp/MVP-BUILD.md §4.6.
"""

from __future__ import annotations


def _digits(jid: str | None) -> str:
    if not jid:
        return ""
    return "".join(c for c in jid.split("@")[0].split(":")[0] if c.isdigit())


def should_respond(envelope: dict, allowlist=None, group_requires_mention: bool = True) -> bool:
    kind = envelope.get("chat_kind")
    if kind == "dm":
        allow = [_digits(a) for a in (allowlist or []) if _digits(a)]
        if not allow:
            return True  # single-owner MVP: no allowlist configured = answer DMs
        return _digits(envelope.get("sender_jid")) in allow
    if kind == "group":
        if group_requires_mention:
            return bool(envelope.get("mentioned_me") or envelope.get("is_reply_to_me"))
        return True
    return False
