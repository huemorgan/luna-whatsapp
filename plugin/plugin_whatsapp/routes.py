"""plugin-whatsapp routes — signed inbound webhook, status, QR proxy, settings.

Inbound flow (MVP, v1 headless per plans/whatsapp/MVP-BUILD.md §4.7):
  verify HMAC → record message → activation policy → build cross-chat context →
  ctx.agent.run_turn → send the reply back through the gateway (deterministic:
  the plugin sends run_turn's text, so there is exactly one reply).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from . import client, db
from .context import build_context_block
from .hmac import verify
from .policy import should_respond

log = logging.getLogger("plugin-whatsapp.routes")

ENV_GATEWAY_ADMIN_KEY = "LUNA_WHATSAPP_GATEWAY_ADMIN_KEY"

PERSONA = (
    "You are replying inside WhatsApp. Keep replies short and chat-style — no "
    "walls of text; split only if truly needed. Reply only to what you were "
    "addressed for; in groups don't dominate. You can see recent messages across "
    "the owner's WhatsApp chats (given below as context) — use them when relevant, "
    "but never leak one chat's private content into another. Never claim you sent "
    "or delivered something you did not."
)

# Read-only tools the agent may use while composing a WhatsApp reply. wa_send /
# wa_react are intentionally excluded here so the reply path stays deterministic
# (the plugin sends run_turn's returned text). Those remain available in normal
# Luna chat for proactive sends.
REPLY_TOOLS = ["wa_context", "wa_list_chats", "recall_conversation"]


def _parse_ts(s):
    if not s:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def _build_prompt(env: dict, context_block: str) -> str:
    chat = env.get("chat_name") or env.get("chat_jid") or "a chat"
    sender = env.get("sender_name") or "the user"
    parts = [PERSONA]
    if context_block:
        parts.append("[Recent WhatsApp across your chats — for context]\n" + context_block)
    current = (env.get("body") or "").strip() or f"<{env.get('kind', 'message')}>"
    parts.append(
        "[Current message — respond to this]\n"
        f"Chat: {chat}\nFrom: {sender}\nMessage: {current}"
    )
    parts.append(
        "Write ONLY the reply text to send back on WhatsApp. If no reply is "
        "warranted, output nothing."
    )
    return "\n\n".join(parts)


def register_routes(app, ctx):
    router = APIRouter(prefix="/api/p/plugin-whatsapp", tags=["whatsapp"])

    @router.post("/inbound")
    async def inbound(request: Request):
        raw = (await request.body()).decode("utf-8")
        ts_hdr = request.headers.get("x-wa-timestamp")
        sig_hdr = request.headers.get("x-wa-signature")
        try:
            secret = await client.shared_secret(ctx)
        except RuntimeError as exc:
            raise HTTPException(503, str(exc))
        if not verify(secret, raw, ts_hdr, sig_hdr):
            raise HTTPException(401, "bad signature")

        try:
            env = json.loads(raw)
        except json.JSONDecodeError:
            raise HTTPException(400, "invalid json")

        msg_ts = _parse_ts(env.get("ts"))
        await db.record_message(
            ctx.engine,
            chat_jid=env.get("chat_jid"),
            chat_kind=env.get("chat_kind", "dm"),
            chat_name=env.get("chat_name"),
            sender_jid=env.get("sender_jid"),
            sender_name=env.get("sender_name"),
            from_me=False,
            wa_msg_id=env.get("wa_msg_id"),
            reply_to_id=env.get("reply_to_id"),
            ts=msg_ts,
            kind=env.get("kind", "text"),
            body=env.get("body"),
        )

        if not should_respond(env, client.allowlist(ctx)):
            return {"ok": True, "answered": False, "reason": "policy"}

        if ctx.agent is None:
            raise HTTPException(503, "agent not ready")

        rows = await db.recent_messages(ctx.engine, limit=80)
        context_block = build_context_block(rows, now=datetime.now(timezone.utc))
        prompt = _build_prompt(env, context_block)

        try:
            result, _usage = await ctx.agent.run_turn(
                prompt, tools=REPLY_TOOLS, memory_read=True, memory_write=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("run_turn failed")
            raise HTTPException(500, f"agent error: {exc}")

        text = (result if isinstance(result, str) else json.dumps(result)).strip()
        if not text:
            return {"ok": True, "answered": False, "reason": "empty"}

        try:
            send_res = await client.send_message(
                ctx, env["chat_jid"], text, env.get("wa_msg_id")
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("gateway send failed")
            raise HTTPException(502, f"send failed: {exc}")

        await db.record_message(
            ctx.engine,
            chat_jid=env.get("chat_jid"),
            chat_kind=env.get("chat_kind", "dm"),
            chat_name=env.get("chat_name"),
            sender_jid=None,
            sender_name="Luna",
            from_me=True,
            wa_msg_id=send_res.get("wa_msg_id"),
            reply_to_id=env.get("wa_msg_id"),
            ts=datetime.now(timezone.utc),
            kind="text",
            body=text,
        )
        return {"ok": True, "answered": True}

    @router.get("/status")
    async def status():
        try:
            h = await client.health(ctx)
            return {"gateway": h}
        except Exception as exc:  # noqa: BLE001
            return {"gateway": None, "error": str(exc)}

    @router.get("/qr", response_class=HTMLResponse)
    async def qr_proxy():
        # Server-side proxy of the gateway's admin QR page so linking happens
        # inside Luna without exposing the gateway admin key to the browser.
        admin = os.environ.get(ENV_GATEWAY_ADMIN_KEY, "").strip()
        if not admin:
            return HTMLResponse(
                "<p style='font-family:sans-serif;padding:24px'>Set "
                "<code>LUNA_WHATSAPP_GATEWAY_ADMIN_KEY</code> to view the QR here, "
                "or open the gateway's <code>/qr?key=…</code> page directly.</p>"
            )
        try:
            url = client.gateway_url(ctx)
        except RuntimeError as exc:
            return HTMLResponse(f"<p style='padding:24px'>{exc}</p>")
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{url}/qr", params={"key": admin})
        return HTMLResponse(r.text, status_code=r.status_code)

    @router.get("/ui/settings/", response_class=HTMLResponse)
    async def settings():
        return HTMLResponse(_SETTINGS_HTML)

    app.include_router(router)


_SETTINGS_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>WhatsApp — Luna</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f0f1e;color:#e0e0e0;padding:24px}
  .card{background:#1a1a2e;border-radius:12px;padding:20px;max-width:560px;margin-bottom:16px}
  code{background:#2a2a3e;padding:2px 6px;border-radius:6px}
  a.btn{display:inline-block;background:#25D366;color:#000;padding:10px 18px;border-radius:8px;
        text-decoration:none;font-weight:600;margin-top:8px}
  pre{white-space:pre-wrap;word-break:break-all}
</style></head><body>
  <div class="card">
    <h2>WhatsApp</h2>
    <p>Link a dedicated WhatsApp number, then Luna replies to your allowlisted
       DMs and to @mentions in groups.</p>
    <a class="btn" href="/api/p/plugin-whatsapp/qr" target="_blank">Open QR to link →</a>
  </div>
  <div class="card">
    <h3>Connection status</h3>
    <pre id="status">loading…</pre>
  </div>
  <script>
    fetch('/api/p/plugin-whatsapp/status').then(r=>r.json())
      .then(d=>{document.getElementById('status').textContent=JSON.stringify(d,null,2)})
      .catch(e=>{document.getElementById('status').textContent=String(e)});
  </script>
</body></html>"""
