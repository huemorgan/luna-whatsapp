"""Data-contract tests: manifest/code agreement + no forbidden core imports."""

import tomllib
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "plugin_whatsapp"


def _toml():
    with open(PKG / "luna-plugin.toml", "rb") as f:
        return tomllib.load(f)


def test_tool_count_matches_requires():
    data = _toml()
    declared = data["requires"]["tools"]
    listed = len(data.get("tools", []))
    assert declared == listed, f"[requires].tools={declared} but {listed} [[tools]] entries"


def test_entry_matches_package_dir():
    data = _toml()
    assert data["entry"] == PKG.name == "plugin_whatsapp"


def test_manifest_matches_code():
    from plugin_whatsapp import WA_TOOL_NAMES, WhatsAppPlugin

    data = _toml()
    m = WhatsAppPlugin.manifest
    assert m.name == data["name"]
    assert m.version == data["version"]
    toml_names = {t["name"] for t in data["tools"]}
    assert set(WA_TOOL_NAMES) == toml_names
    assert len(WA_TOOL_NAMES) == data["requires"]["tools"]


def test_no_forbidden_core_imports():
    offenders = []
    for py in PKG.glob("*.py"):
        text = py.read_text()
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("import luna.") or s.startswith("from luna."):
                if "luna_sdk" not in s:
                    offenders.append(f"{py.name}: {s}")
    assert not offenders, f"forbidden core imports: {offenders}"
