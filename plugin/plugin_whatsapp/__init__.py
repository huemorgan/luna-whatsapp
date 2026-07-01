"""plugin-whatsapp — connect Luna to WhatsApp via the luna-wa-gateway.

Receives signed inbound events from the gateway, applies an activation policy,
builds a cross-chat context window, runs the agent, and sends the reply back
through the gateway. Owns its message store (isolated tables via
``luna_sdk.declarative_base()``). Imports ``luna_sdk`` only — never ``luna.*``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from luna_sdk import LunaPlugin, PluginContext, PluginManifest, SettingsTab, ToolDef

from . import client, db
from .context import build_context_block

log = logging.getLogger("plugin-whatsapp")

WA_TOOL_NAMES = ["wa_context", "wa_list_chats", "wa_status", "wa_send", "wa_react"]

_CAPABILITY_NOTE = (
    "WhatsApp: you are connected to a WhatsApp number. You can read recent "
    "cross-chat context with `wa_context`, list chats with `wa_list_chats`, "
    "check link health with `wa_status`, send a message with `wa_send`, and react "
    "with `wa_react`. Keep WhatsApp replies short and chat-style."
)


class WhatsAppPlugin(LunaPlugin):
    manifest = PluginManifest(
        name="plugin-whatsapp",
        version="0.1.0",
        description="Connect Luna to WhatsApp (Baileys gateway): inbound, context, replies.",
        category="connectors",
        depends_on=["plugin-vault"],
        routes_module="routes",
        license="MIT",
        settings_tabs=[
            SettingsTab(
                id="whatsapp",
                label="WhatsApp",
                icon="message-circle",
                sort_order=66,
                iframe_src="/api/p/plugin-whatsapp/ui/settings/",
            ),
        ],
    )

    async def on_load(self, ctx: PluginContext) -> None:
        await db.create_tables(ctx.engine)
        self._register_tools(ctx)
        log.info("plugin-whatsapp loaded (tools=5)")

    async def prompt_sections(self) -> list[str]:
        return [_CAPABILITY_NOTE]

    def _register_tools(self, ctx: PluginContext) -> None:
        plugin = self.manifest.name

        def _reg(tool_def: ToolDef, handler) -> None:
            ctx.tool_registry.register(plugin, tool_def, handler)

        async def _wa_context(minutes: int = 5, max_messages: int = 30,
                              chat_jid: str | None = None) -> dict[str, Any]:
            rows = await db.recent_messages(ctx.engine, limit=200, chat_jid=chat_jid)
            block = build_context_block(
                rows, now=datetime.now(timezone.utc),
                minutes=minutes, max_messages=max_messages,
            )
            return {"context": block}

        _reg(
            ToolDef(
                name="wa_context",
                description=(
                    "Read recent WhatsApp messages across the owner's chats "
                    "(union of last N minutes and last M messages), attributed by "
                    "chat/sender/time. Use to resolve a cross-chat reference."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "minutes": {"type": "integer", "default": 5},
                        "max_messages": {"type": "integer", "default": 30},
                        "chat_jid": {"type": "string", "description": "Limit to one chat."},
                    },
                },
                policy="auto_approve",
                risk_level="low",
                sensitive_args=["body"],
            ),
            _wa_context,
        )

        async def _wa_list_chats(limit: int = 50) -> dict[str, Any]:
            return {"chats": await db.list_chats(ctx.engine, limit=limit)}

        _reg(
            ToolDef(
                name="wa_list_chats",
                description="List known WhatsApp chats (DMs and groups).",
                parameters={
                    "type": "object",
                    "properties": {"limit": {"type": "integer", "default": 50}},
                },
                policy="auto_approve",
                risk_level="low",
            ),
            _wa_list_chats,
        )

        async def _wa_status() -> dict[str, Any]:
            try:
                return await client.health(ctx)
            except Exception as exc:  # noqa: BLE001
                return {"connected": False, "error": str(exc)}

        _reg(
            ToolDef(
                name="wa_status",
                description="Check WhatsApp link/connection health via the gateway.",
                parameters={"type": "object", "properties": {}},
                policy="auto_approve",
                risk_level="low",
            ),
            _wa_status,
        )

        async def _wa_send(chat_jid: str, text: str,
                          reply_to: str | None = None) -> dict[str, Any]:
            return await client.send_message(ctx, chat_jid, text, reply_to)

        _reg(
            ToolDef(
                name="wa_send",
                description=(
                    "Send a WhatsApp message to a chat (by chat_jid). External "
                    "side-effect — use deliberately."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "chat_jid": {"type": "string", "description": "Target chat JID."},
                        "text": {"type": "string", "description": "Message body."},
                        "reply_to": {"type": "string", "description": "wa_msg_id to quote."},
                    },
                    "required": ["chat_jid", "text"],
                },
                policy="ask",
                risk_level="medium",
                sensitive_args=["text"],
            ),
            _wa_send,
        )

        async def _wa_react(chat_jid: str, wa_msg_id: str, emoji: str) -> dict[str, Any]:
            return await client.react_message(ctx, chat_jid, wa_msg_id, emoji)

        _reg(
            ToolDef(
                name="wa_react",
                description="React to a WhatsApp message with an emoji.",
                parameters={
                    "type": "object",
                    "properties": {
                        "chat_jid": {"type": "string"},
                        "wa_msg_id": {"type": "string"},
                        "emoji": {"type": "string"},
                    },
                    "required": ["chat_jid", "wa_msg_id", "emoji"],
                },
                policy="ask",
                risk_level="low",
            ),
            _wa_react,
        )


__all__ = ["WhatsAppPlugin", "WA_TOOL_NAMES"]
