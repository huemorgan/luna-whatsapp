"""Gateway HTTP client + config/secret resolution.

The plugin never opens a WhatsApp socket — it sends by calling the gateway's
signed ``/send`` and ``/react`` endpoints, and reads link health from ``/health``.
"""

from __future__ import annotations

import json
import logging
import os

import httpx

from .hmac import sign

log = logging.getLogger("plugin-whatsapp.client")

ENV_GATEWAY_URL = "LUNA_WHATSAPP_GATEWAY_URL"
ENV_SHARED_SECRET = "LUNA_WHATSAPP_SHARED_SECRET"
ENV_ALLOWLIST = "LUNA_WHATSAPP_ALLOWLIST"
VAULT_SECRET_KEY = "plugin_whatsapp.shared_secret"


def _env(ctx, name: str) -> str:
    getter = getattr(ctx, "get_env", None)
    if getter is not None:
        val = getter(name)
        if val:
            return val.strip()
    return (os.environ.get(name) or "").strip()


def gateway_url(ctx) -> str:
    url = _env(ctx, ENV_GATEWAY_URL)
    if not url:
        raise RuntimeError(f"{ENV_GATEWAY_URL} not configured")
    return url.rstrip("/")


async def shared_secret(ctx) -> str:
    vault = getattr(ctx, "vault", None)
    if vault is not None:
        try:
            cred = await vault.get_credential(VAULT_SECRET_KEY)
            if (cred.value or "").strip():
                return cred.value.strip()
        except KeyError:
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("vault read failed: %s", exc)
    val = _env(ctx, ENV_SHARED_SECRET)
    if not val:
        raise RuntimeError(f"{ENV_SHARED_SECRET} not configured (and not in vault)")
    return val


def allowlist(ctx) -> list[str]:
    raw = _env(ctx, ENV_ALLOWLIST)
    return [p.strip() for p in raw.split(",") if p.strip()] if raw else []


async def send_message(ctx, chat_jid: str, text: str, reply_to: str | None = None) -> dict:
    url = gateway_url(ctx)
    secret = await shared_secret(ctx)
    body = json.dumps({"chat_jid": chat_jid, "text": text, "reply_to": reply_to})
    ts, sig = sign(secret, body)
    headers = {
        "content-type": "application/json",
        "x-wa-timestamp": ts,
        "x-wa-signature": sig,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{url}/send", content=body, headers=headers)
        r.raise_for_status()
        return r.json()


async def react_message(ctx, chat_jid: str, wa_msg_id: str, emoji: str) -> dict:
    url = gateway_url(ctx)
    secret = await shared_secret(ctx)
    body = json.dumps({"chat_jid": chat_jid, "wa_msg_id": wa_msg_id, "emoji": emoji})
    ts, sig = sign(secret, body)
    headers = {
        "content-type": "application/json",
        "x-wa-timestamp": ts,
        "x-wa-signature": sig,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"{url}/react", content=body, headers=headers)
        r.raise_for_status()
        return r.json()


async def health(ctx) -> dict:
    url = gateway_url(ctx)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{url}/health")
        r.raise_for_status()
        return r.json()
