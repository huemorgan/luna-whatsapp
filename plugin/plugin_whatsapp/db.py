"""Plugin-owned WhatsApp message store (context source of truth for the agent).

Isolated metadata via ``luna_sdk.declarative_base()`` + ``ctx.engine`` (enabler
E4) — never touches core's Base. Populated from ``/inbound`` events and from
``from_me`` replies the agent sends, so the cross-chat context window is complete.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, String, Text, insert, select
from sqlalchemy.orm import Mapped, mapped_column

from luna_sdk import UUID, declarative_base

Base = declarative_base()


class WhatsAppMessage(Base):
    __tablename__ = "whatsapp_plugin_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=uuid.uuid4)
    chat_jid: Mapped[str] = mapped_column(String(128), index=True)
    chat_kind: Mapped[str] = mapped_column(String(16))
    chat_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    sender_jid: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sender_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    from_me: Mapped[bool] = mapped_column(Boolean, default=False)
    wa_msg_id: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    reply_to_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    kind: Mapped[str] = mapped_column(String(32), default="text")
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


_T = WhatsAppMessage.__table__


async def create_tables(engine) -> None:
    async with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            await conn.run_sync(table.create, checkfirst=True)


async def record_message(engine, **fields) -> bool:
    """Insert one message. Idempotent on wa_msg_id. Returns True if inserted."""
    wa_msg_id = fields.get("wa_msg_id")
    async with engine.begin() as conn:
        if wa_msg_id:
            existing = await conn.execute(
                select(_T.c.id).where(_T.c.wa_msg_id == wa_msg_id).limit(1)
            )
            if existing.first() is not None:
                return False
        fields.setdefault("id", uuid.uuid4())
        await conn.execute(insert(_T).values(**fields))
    return True


async def recent_messages(engine, limit: int = 60, chat_jid: str | None = None) -> list[dict]:
    stmt = select(
        _T.c.chat_jid, _T.c.chat_name, _T.c.chat_kind, _T.c.sender_name,
        _T.c.from_me, _T.c.body, _T.c.ts, _T.c.kind,
    ).order_by(_T.c.ts.desc()).limit(limit)
    if chat_jid:
        stmt = stmt.where(_T.c.chat_jid == chat_jid)
    async with engine.connect() as conn:
        rows = (await conn.execute(stmt)).mappings().all()
    return [dict(r) for r in rows]


async def list_chats(engine, limit: int = 50) -> list[dict]:
    stmt = (
        select(_T.c.chat_jid, _T.c.chat_kind, _T.c.chat_name)
        .distinct()
        .limit(limit)
    )
    async with engine.connect() as conn:
        rows = (await conn.execute(stmt)).mappings().all()
    return [dict(r) for r in rows]
