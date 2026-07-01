"""Cross-chat context engine (pure functions, no luna_sdk).

The headline feature: in group B the agent references something from group A and
knows it, within 5 minutes OR 30 messages, owner-global, each line attributed
``[chat · sender · t-Δ]``. See plans/whatsapp/MVP-BUILD.md §4.
"""

from __future__ import annotations

from datetime import datetime, timezone


def _humanize_delta(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


def select_window(messages, now=None, minutes=5, max_messages=30):
    """Pick the union of (last `minutes`) and (last `max_messages`).

    `messages`: iterable of dicts with at least `ts` (aware datetime). May be in
    any order. Returns the selected subset sorted oldest→newest.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - minutes * 60

    def _ts(m):
        t = m["ts"]
        if isinstance(t, str):
            t = _parse_ts(t)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.timestamp()

    ordered = sorted(messages, key=_ts, reverse=True)  # newest first
    selected = []
    for i, m in enumerate(ordered):
        in_time = _ts(m) >= cutoff
        in_count = i < max_messages
        if in_time or in_count:
            selected.append(m)
        else:
            break
    selected.reverse()  # oldest→newest
    return selected


def build_context_block(messages, now=None, minutes=5, max_messages=30) -> str:
    """Render the attributed cross-chat context block, or '' if empty."""
    now = now or datetime.now(timezone.utc)
    picked = select_window(messages, now=now, minutes=minutes, max_messages=max_messages)
    if not picked:
        return ""
    lines = []
    for m in picked:
        t = m["ts"]
        if isinstance(t, str):
            t = _parse_ts(t)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        delta = _humanize_delta(now.timestamp() - t.timestamp())
        chat = m.get("chat_name") or m.get("chat_jid") or "chat"
        sender = "you" if m.get("from_me") else (m.get("sender_name") or "someone")
        body = (m.get("body") or "").strip()
        if not body:
            body = f"<{m.get('kind', 'message')}>"
        lines.append(f"[{chat} · {sender} · {delta} ago] {body}")
    return "\n".join(lines)


def _parse_ts(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    return datetime.fromisoformat(s)
