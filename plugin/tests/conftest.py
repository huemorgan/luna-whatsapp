"""Minimal luna_sdk stub so the plugin package imports without the Luna runtime.

Per plugin-testing.mdc: unit tests must not depend on the real luna_sdk being
importable. We register a tiny fake into sys.modules BEFORE plugin_whatsapp is
imported. declarative_base/UUID are backed by real SQLAlchemy so db.py's model
still builds.
"""

import sys
import types

from sqlalchemy import Uuid
from sqlalchemy.orm import DeclarativeBase


def _make_luna_sdk_stub() -> types.ModuleType:
    mod = types.ModuleType("luna_sdk")

    class LunaPlugin:  # noqa: D401
        manifest = None

        async def on_load(self, ctx):  # pragma: no cover
            ...

    class _Kwargs:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    class PluginManifest(_Kwargs):
        pass

    class SettingsTab(_Kwargs):
        pass

    class ToolDef(_Kwargs):
        pass

    class PluginContext:  # pragma: no cover
        pass

    def declarative_base():
        class Base(DeclarativeBase):
            pass
        return Base

    mod.LunaPlugin = LunaPlugin
    mod.PluginManifest = PluginManifest
    mod.SettingsTab = SettingsTab
    mod.ToolDef = ToolDef
    mod.PluginContext = PluginContext
    mod.declarative_base = declarative_base
    mod.UUID = Uuid
    mod.JSONB = None
    return mod


if "luna_sdk" not in sys.modules:
    sys.modules["luna_sdk"] = _make_luna_sdk_stub()
