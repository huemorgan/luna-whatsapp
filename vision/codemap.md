# Code map — where everything lives, and which end it belongs to

> Both ends live in this one repo on purpose, so an agent fixing a bug can see the
> gateway side and the plugin side together. When a fix touches the boundary
> ([`contract.md`](contract.md)), it almost always edits a file in **both**
> columns below.

```
luna-whatsapp/
├── gateway/                         ── THE GATEWAY END (Node + Baileys, always-on)
│   ├── src/
│   │   ├── index.js                 HTTP server: /health /qr /stats /send /react
│   │   │                            + /accounts admin API (003); boots everything
│   │   ├── session.js               Session class (one per account): connect, QR, watchdog,
│   │   │                            reconnect, 100% capture, sendText/react + pure helpers
│   │   ├── accounts.js              account registry: lifecycle, auth-dir migration,
│   │   │                            HMAC→account resolution (x-wa-account / secret scan)
│   │   ├── db.js                    Postgres schema + whatsapp_accounts registry + capture
│   │   ├── inbound.js               HMAC-signs the envelope with the ACCOUNT's secret,
│   │   │                            POSTs to that account's Luna
│   │   ├── stats.js                 /stats payload assembly (global + accounts[])
│   │   ├── hmac.js                  SIGN/VERIFY  ← must match plugin/…/hmac.py exactly
│   │   └── config.js                env parsing (legacy single-account vars = seed only)
│   ├── Dockerfile · package.json · .env.example · .dockerignore
│
├── plugin/                          ── THE LUNA PLUGIN END (Python, loaded in Luna)
│   ├── plugin_whatsapp/
│   │   ├── __init__.py              LunaPlugin subclass, manifest, on_load, tool registration,
│   │   │                            WA_TOOL_NAMES, prompt_sections
│   │   ├── routes.py                POST /inbound (verify→record→policy→context→run_turn→send),
│   │   │                            /status, /qr proxy, /ui/settings/, persona + prompt builder
│   │   ├── client.py                gateway HTTP client (send/react/health) + config/secret resolve
│   │   ├── db.py                    plugin-owned table (declarative_base) + record/recent/list
│   │   ├── context.py               PURE cross-chat window select + attributed formatting
│   │   ├── policy.py                PURE activation policy (DM allowlist / group @mention)
│   │   ├── hmac.py                  SIGN/VERIFY  ← must match gateway/src/hmac.js exactly
│   │   └── luna-plugin.toml         data manifest (keep in sync with __init__ PluginManifest)
│   ├── pyproject.toml
│   └── tests/                       conftest (luna_sdk stub) + hmac/context/policy/manifest tests
│
├── render.yaml                      Render blueprint: gateway web svc + disk + luna-wa-db
├── README.md                        setup / deploy / QR / wiring
├── LICENSE (MIT)
└── vision/                          ← you are here
    ├── vision.md                    the north star (read first)
    ├── architecture.md              topology, data flow, sequences, failure modes
    ├── contract.md                  the gateway↔plugin wire contract (the "both ends" doc)
    ├── luna-integration.md          the luna_sdk surface the plugin depends on
    ├── roadmap.md                   phases, known gaps, acceptance criteria
    └── codemap.md                   this file
```

## "If I'm changing X, which files?"

| Change | Gateway files | Plugin files |
|---|---|---|
| The inbound message shape | `wa.js` (forwardInbound payload), `inbound.js` | `routes.py` (`inbound` parser), maybe `db.py` |
| The send request/response | `index.js` `/send`, `wa.js` `sendText` | `client.py` `send_message`, `routes.py` reply path |
| The HMAC scheme | `hmac.js` | `hmac.py` (keep byte-identical!) |
| Activation rules | (gateway sets `mentioned_me`/`is_reply_to_me`) | `policy.py` |
| Context window semantics | (n/a — source data only) | `context.py`, `routes.py`, `__init__.py` (`wa_context`) |
| Keepalive / reconnect / QR | `wa.js`, `index.js`, `config.js` | (surfaced via `wa_status` / `/status`) |
| A new tool | (maybe a new gateway endpoint) | `__init__.py`, `luna-plugin.toml`, `WA_TOOL_NAMES`, tests |
| DB columns (gateway) | `db.js` | – |
| DB columns (plugin context store) | – | `db.py` |

## Golden rule

The two `hmac.*` files and the [`contract.md`](contract.md) envelope are the
"treaty" between the ends. Touch one side of the treaty, touch the other, and update
the contract doc — in the same commit.
