#!/usr/bin/env python3
"""Dojo-style conversation tests for the WhatsApp bridge.

Each scenario in ``conversations/*.md`` is a real conversation: a machine ``json``
block (the turns to send) plus a prose "## Expect" rubric describing what a GOOD
reply looks like — in plain English, not code assertions.

For every scenario the runner:
  1. sends the turn(s) through the *real* bridge (HMAC-signed POST to the running
     plugin's /inbound, exactly like the gateway does),
  2. captures Luna's actual reply from the plugin store (whatsapp_plugin_messages),
  3. asks an LLM judge to read the reply against the prose rubric and return a
     verdict (pass / partial / fail) with what matched and what was missed,
  4. writes everything to RESULTS.md.

This is dojo philosophy: the agent LLM answers for real, and an LLM reads the
answer and judges it against what we said we wanted to see. No brittle string
matching.

Usage:
    python3 run_dojo.py                 # run all scenarios
    python3 run_dojo.py 04 06           # run scenarios whose id contains these
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CONV_DIR = HERE / "conversations"
RESULTS = HERE / "RESULTS.md"

GATEWAY_ENV = REPO / "gateway" / ".env"
# The running Luna is the sibling ../luna; the submodule luna/ may lack .env.
LUNA_ENV = next(
    (p for p in (REPO.parent / "luna" / ".env", REPO / "luna" / ".env") if p.exists()),
    REPO / "luna" / ".env",
)
DB_HELPER = REPO / "gateway" / "tools" / "db_helper.mjs"

INBOUND_URL = "http://localhost:3000/api/p/plugin-whatsapp/inbound"
SELF_JID = "15550001111@s.whatsapp.net"
JUDGE_MODEL = "claude-sonnet-4-6"


# ---------------------------------------------------------------------------
# env helpers
# ---------------------------------------------------------------------------
def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


GW = load_env(GATEWAY_ENV)
LN = load_env(LUNA_ENV)
SECRET = GW.get("WA_SHARED_SECRET", "")
ANTHROPIC_KEY = LN.get("LUNA_ANTHROPIC_API_KEY", "")


# ---------------------------------------------------------------------------
# scenario parsing
# ---------------------------------------------------------------------------
def parse_scenario(path: Path) -> dict:
    text = path.read_text()
    m = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
    if not m:
        raise ValueError(f"{path.name}: missing ```json block")
    cfg = json.loads(m.group(1))
    ex = re.split(r"^##\s*Expect\s*$", text, flags=re.MULTILINE)
    cfg["rubric"] = ex[1].strip() if len(ex) > 1 else text[m.end():].strip()
    cfg["_file"] = path.name
    return cfg


def resolve_jid(turn: dict) -> tuple[str, str]:
    """Return (jid, chat_kind) for a turn."""
    kind = turn.get("kind", "dm")
    if turn.get("jid"):
        return turn["jid"], kind
    chat = turn.get("chat", "self")
    if chat == "self":
        return SELF_JID, kind
    # deterministic fake group jid from the label
    n = int(hashlib.sha1(chat.encode()).hexdigest()[:12], 16)
    return f"1203{n:015d}@g.us", kind


# ---------------------------------------------------------------------------
# bridge I/O
# ---------------------------------------------------------------------------
def db(action: str, **kw) -> object:
    cmd = ["node", f"--env-file={GATEWAY_ENV}", str(DB_HELPER), action]
    for k, v in kw.items():
        cmd += [f"--{k}", str(v)]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO / "gateway"))
    if r.returncode != 0:
        raise RuntimeError(f"db {action} failed: {r.stderr.strip()}")
    return json.loads(r.stdout.strip() or "null")


def sign(raw: str) -> tuple[str, str]:
    ts = str(int(time.time()))
    mac = hmac.new(SECRET.encode(), f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    return ts, mac


def post_inbound(env: dict) -> dict:
    raw = json.dumps(env)
    ts, sig = sign(raw)
    req = urllib.request.Request(
        INBOUND_URL,
        data=raw.encode(),
        headers={
            "content-type": "application/json",
            "x-wa-timestamp": ts,
            "x-wa-signature": sig,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        return json.loads(resp.read().decode() or "{}")


def send_turn(turn: dict) -> dict:
    jid, kind = resolve_jid(turn)
    env = {
        "account": "default",
        "chat_jid": jid,
        "chat_kind": kind,
        "chat_name": turn.get("name") if kind == "group" else None,
        "sender_jid": SELF_JID,
        "sender_name": "Roy",
        "wa_msg_id": "SIM-" + uuid.uuid4().hex[:12],
        "reply_to_id": None,
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "kind": "text",
        "body": turn.get("text", ""),
        "mentioned_me": bool(turn.get("mentioned", False)),
        "is_reply_to_me": False,
    }
    return post_inbound(env)


def run_turns(cfg: dict) -> dict:
    """Run every turn; return {'sent':..., 'reply':..., 'media':[...], 'resp':...}."""
    judged = None
    for t in cfg["turns"]:
        if t.get("plant"):
            jid, kind = resolve_jid(t)
            db("plant", chat=jid, kind=kind, name=t.get("name", "Someone"),
               text=t.get("text", ""))
            continue
        if t.get("judge"):
            judged = t
        if not t.get("judge"):
            send_turn(t)
            time.sleep(1)

    if judged is None:
        judged = cfg["turns"][-1]
    jid, _ = resolve_jid(judged)
    wm = db("watermark", chat=jid)["wm"]
    resp = send_turn(judged)

    rows = []
    for _ in range(8):
        rows = db("fetch", chat=jid, since=wm)
        if rows:
            break
        time.sleep(1.5)

    texts = [r["body"] for r in rows if r["kind"] == "text" and r["body"].strip()]
    media = [{"kind": r["kind"], "url": r["body"]} for r in rows if r["kind"] != "text"]
    reply = "\n".join(texts).strip()
    if not reply and not media:
        reply = "(no reply — stayed silent)"
    return {"sent": judged.get("text", ""), "reply": reply, "media": media, "resp": resp}


# ---------------------------------------------------------------------------
# LLM judge
# ---------------------------------------------------------------------------
JUDGE_SYS = (
    "You are a strict QA judge for Luna, an AI assistant that replies over "
    "WhatsApp. You are given the message the user sent, Luna's ACTUAL reply "
    "(and any media it delivered), and a rubric describing what a GOOD reply "
    "looks like on WhatsApp. Decide whether the actual reply satisfies the "
    "rubric. Be strict about the 'must NOT' items — any leaked reasoning, meta "
    "narration, or capability-punting is a fail. Reply with ONLY a JSON object: "
    '{"verdict":"pass"|"partial"|"fail","matched":["..."],"missed":["..."],'
    '"notes":"one or two sentences"}'
)


def judge(cfg: dict, run: dict) -> dict:
    media_desc = (
        "\n".join(f"- media delivered: {m['kind']} -> {m['url']}" for m in run["media"])
        or "(no media delivered)"
    )
    user = (
        f"USER SENT:\n{run['sent'] or '(empty message)'}\n\n"
        f"LUNA'S ACTUAL REPLY:\n{run['reply']}\n\n"
        f"MEDIA:\n{media_desc}\n\n"
        f"RUBRIC (what a good reply looks like):\n{cfg['rubric']}"
    )
    body = json.dumps({
        "model": JUDGE_MODEL,
        "max_tokens": 700,
        "system": JUDGE_SYS,
        "messages": [{"role": "user", "content": user}],
    })
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body.encode(),
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        d = json.loads(resp.read().decode())
    raw = d["content"][0]["text"].strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"verdict": "error", "matched": [], "missed": [],
                "notes": f"could not parse judge output: {raw[:200]}"}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> None:
    if not SECRET:
        sys.exit("WA_SHARED_SECRET not found in gateway/.env")
    if not ANTHROPIC_KEY:
        sys.exit("LUNA_ANTHROPIC_API_KEY not found in luna/.env")

    filters = sys.argv[1:]
    files = sorted(CONV_DIR.glob("*.md"))
    scenarios = [parse_scenario(f) for f in files]
    if filters:
        scenarios = [s for s in scenarios if any(f in s["id"] for f in filters)]

    results = []
    for cfg in scenarios:
        print(f"\n=== {cfg['id']} — {cfg['title']} ===", flush=True)
        try:
            run = run_turns(cfg)
        except Exception as exc:  # noqa: BLE001
            print(f"  RUN ERROR: {exc}", flush=True)
            results.append((cfg, {"sent": "", "reply": f"(run error: {exc})",
                                  "media": [], "resp": {}},
                            {"verdict": "error", "matched": [], "missed": [],
                             "notes": str(exc)}))
            continue
        print(f"  sent : {run['sent']!r}", flush=True)
        print(f"  reply: {run['reply'][:200]!r}"
              + (f"  [+{len(run['media'])} media]" if run["media"] else ""), flush=True)
        v = judge(cfg, run)
        print(f"  VERDICT: {v['verdict'].upper()}  — {v.get('notes', '')}", flush=True)
        results.append((cfg, run, v))

    write_results(results)
    passed = sum(1 for _, _, v in results if v["verdict"] == "pass")
    print(f"\n{'='*60}\n{passed}/{len(results)} passed. See {RESULTS}", flush=True)


def write_results(results: list) -> None:
    lines = [
        "# Dojo conversation test results",
        "",
        f"_Run: {datetime.now().strftime('%Y-%m-%d %H:%M')} · judge: {JUDGE_MODEL} · "
        "real bridge → running Luna._",
        "",
        "| # | Scenario | Verdict |",
        "|---|----------|---------|",
    ]
    icon = {"pass": "✅ pass", "partial": "🟡 partial", "fail": "❌ fail",
            "error": "⚠️ error"}
    for cfg, _, v in results:
        lines.append(f"| {cfg['id'][:2]} | {cfg['title']} | {icon.get(v['verdict'], v['verdict'])} |")
    lines.append("")
    for cfg, run, v in results:
        lines += [
            f"## {cfg['id']} — {cfg['title']}",
            "",
            f"**Verdict: {icon.get(v['verdict'], v['verdict'])}**",
            "",
            f"**User sent:** {run['sent'] or '_(empty message)_'}",
            "",
            "**Luna replied:**",
            "",
            "```",
            run["reply"],
            "```",
        ]
        if run["media"]:
            lines.append("")
            for m in run["media"]:
                lines.append(f"- media: `{m['kind']}` → {m['url']}")
        lines += [
            "",
            f"**Matched:** {'; '.join(v.get('matched', [])) or '—'}",
            "",
            f"**Missed:** {'; '.join(v.get('missed', [])) or '—'}",
            "",
            f"**Judge notes:** {v.get('notes', '')}",
            "",
            "---",
            "",
        ]
    RESULTS.write_text("\n".join(lines))


if __name__ == "__main__":
    main()
