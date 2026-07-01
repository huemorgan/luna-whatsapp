import time

from plugin_whatsapp.hmac import sign, verify


def test_sign_verify_roundtrip():
    secret = "s3cr3t"
    body = '{"a":1}'
    ts, sig = sign(secret, body)
    assert verify(secret, body, ts, sig)


def test_tampered_body_fails():
    secret = "s3cr3t"
    ts, sig = sign(secret, '{"a":1}')
    assert not verify(secret, '{"a":2}', ts, sig)


def test_wrong_secret_fails():
    ts, sig = sign("one", "body")
    assert not verify("two", "body", ts, sig)


def test_stale_timestamp_fails():
    secret = "s3cr3t"
    old = str(int(time.time()) - 10_000)
    _, sig = sign(secret, "body", timestamp=old)
    assert not verify(secret, "body", old, sig)


def test_missing_headers_fail():
    assert not verify("s", "body", None, None)
