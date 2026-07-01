from plugin_whatsapp.policy import should_respond


def test_dm_no_allowlist_answers():
    assert should_respond({"chat_kind": "dm", "sender_jid": "123@s.whatsapp.net"}, [])


def test_dm_allowlist_match():
    env = {"chat_kind": "dm", "sender_jid": "1555000@s.whatsapp.net"}
    assert should_respond(env, ["+1 555 000"])
    assert not should_respond({"chat_kind": "dm", "sender_jid": "999@s.whatsapp.net"}, ["+1555000"])


def test_group_requires_mention():
    base = {"chat_kind": "group", "sender_jid": "1@s.whatsapp.net"}
    assert not should_respond(base, [])
    assert should_respond({**base, "mentioned_me": True}, [])
    assert should_respond({**base, "is_reply_to_me": True}, [])


def test_group_open_when_mention_disabled():
    env = {"chat_kind": "group", "sender_jid": "1@s.whatsapp.net"}
    assert should_respond(env, [], group_requires_mention=False)
