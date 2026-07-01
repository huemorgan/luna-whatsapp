from datetime import datetime, timedelta, timezone

from plugin_whatsapp.context import build_context_block, select_window


def _msg(chat, sender, body, ts, from_me=False):
    return {
        "chat_name": chat, "chat_jid": chat + "@g.us", "sender_name": sender,
        "from_me": from_me, "body": body, "ts": ts, "kind": "text",
    }


def test_cross_chat_window_is_time_ordered_and_attributed():
    now = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
    msgs = [
        _msg("Group A", "Roy", "launch is Tuesday", now - timedelta(minutes=2)),
        _msg("Group B", "Roy", "what did I say about the launch?", now - timedelta(seconds=10)),
    ]
    block = build_context_block(msgs, now=now, minutes=5, max_messages=30)
    lines = block.splitlines()
    # oldest first
    assert "Group A" in lines[0] and "launch is Tuesday" in lines[0]
    assert "Group B" in lines[1]
    # attribution format
    assert "· Roy ·" in lines[0]
    assert "ago]" in lines[0]


def test_time_window_union_pulls_old_message_when_under_count():
    now = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
    old = _msg("Group A", "Roy", "old but few", now - timedelta(hours=3))
    # Only one message total, so count-rule (<30) keeps it even though outside 5min.
    block = build_context_block([old], now=now, minutes=5, max_messages=30)
    assert "old but few" in block


def test_count_limit_trims_when_many_recent():
    now = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
    # 40 messages all just outside the 5-min window → only last 30 by count kept.
    msgs = [
        _msg("G", "R", f"m{i}", now - timedelta(minutes=6, seconds=i))
        for i in range(40)
    ]
    picked = select_window(msgs, now=now, minutes=5, max_messages=30)
    assert len(picked) == 30


def test_empty_returns_blank():
    assert build_context_block([], now=datetime.now(timezone.utc)) == ""
