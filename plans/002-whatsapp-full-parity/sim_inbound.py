#!/usr/bin/env python3
"""Simulate a gateway->plugin inbound webhook against a running Luna.

This posts exactly the HMAC-signed envelope the real gateway posts, so it drives
the true reply path: verify -> record -> policy -> run_turn (REAL agent, full
toolkit) -> reply back through the gateway to real WhatsApp.

Usage:
  python sim_inbound.py "message body" [--chat JID] [--name NAME] [--group]

Env:
  LUNA_WHATSAPP_SHARED_SECRET  (defaults to the value in ../../luna/.env if set)
  LUNA_INBOUND_URL             (default http://localhost:3000/api/p/plugin-whatsapp/inbound)
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import time
import uuid
import urllib.request

DEFAULT_URL = "http://localhost:3000/api/p/plugin-whatsapp/inbound"


def sign(secret: str, raw: str) -> tuple[str, str]:
    ts = str(int(time.time()))
    mac = hmac.new(secret.encode(), f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    return ts, mac


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("body")
    ap.add_argument("--chat", default="15550001111@s.whatsapp.net")
    ap.add_argument("--name", default="Sim Harness")
    ap.add_argument("--group", action="store_true")
    ap.add_argument("--url", default=os.environ.get("LUNA_INBOUND_URL", DEFAULT_URL))
    args = ap.parse_args()

    secret = os.environ.get("LUNA_WHATSAPP_SHARED_SECRET", "").strip()
    if not secret:
        raise SystemExit("set LUNA_WHATSAPP_SHARED_SECRET")

    env = {
        "account": "default",
        "chat_jid": args.chat,
        "chat_kind": "group" if args.group else "dm",
        "chat_name": args.name if args.group else None,
        "sender_jid": args.chat,
        "sender_name": args.name,
        "wa_msg_id": "SIM-" + uuid.uuid4().hex[:12],
        "reply_to_id": None,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "kind": "text",
        "body": args.body,
        "mentioned_me": bool(args.group),
        "is_reply_to_me": False,
    }
    raw = json.dumps(env)
    ts, sig = sign(secret, raw)
    req = urllib.request.Request(
        args.url,
        data=raw.encode(),
        headers={
            "content-type": "application/json",
            "x-wa-timestamp": ts,
            "x-wa-signature": sig,
        },
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as resp:
        out = resp.read().decode()
        dt = time.time() - t0
        print(f"HTTP {resp.status}  ({dt:.1f}s)")
        print(out)


if __name__ == "__main__":
    main()
