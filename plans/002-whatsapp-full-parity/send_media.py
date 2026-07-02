#!/usr/bin/env python3
"""Send a local image/file to WhatsApp via the gateway's signed /send-media.

Demonstrates delivery of an internal asset (e.g. a browser screenshot) to
WhatsApp as native media — the full-parity media path.

Usage: python send_media.py <path> [--chat JID] [--caption TEXT] [--kind image]
Env:   WA_SHARED_SECRET or LUNA_WHATSAPP_SHARED_SECRET, GATEWAY_URL (default :10000)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.request


def sign(secret: str, raw: str) -> tuple[str, str]:
    ts = str(int(time.time()))
    mac = hmac.new(secret.encode(), f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    return ts, mac


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--chat", default="15550001111@s.whatsapp.net")
    ap.add_argument("--caption", default="")
    ap.add_argument("--kind", default="image")
    ap.add_argument("--gateway", default=os.environ.get("GATEWAY_URL", "http://localhost:10000"))
    args = ap.parse_args()

    secret = (os.environ.get("WA_SHARED_SECRET")
              or os.environ.get("LUNA_WHATSAPP_SHARED_SECRET") or "").strip()
    if not secret:
        raise SystemExit("set WA_SHARED_SECRET / LUNA_WHATSAPP_SHARED_SECRET")

    with open(args.path, "rb") as f:
        data_b64 = base64.b64encode(f.read()).decode()

    payload = {"chat_jid": args.chat, "kind": args.kind, "data_base64": data_b64}
    if args.caption:
        payload["caption"] = args.caption
    raw = json.dumps(payload)
    ts, sig = sign(secret, raw)
    req = urllib.request.Request(
        f"{args.gateway.rstrip('/')}/send-media",
        data=raw.encode(),
        headers={"content-type": "application/json",
                 "x-wa-timestamp": ts, "x-wa-signature": sig},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as resp:
        print(f"HTTP {resp.status} ({time.time()-t0:.1f}s)  {resp.read().decode()}")


if __name__ == "__main__":
    main()
