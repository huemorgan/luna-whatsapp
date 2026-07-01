# luna-whatsapp

Connect [Luna](https://luna.com.ai) to **WhatsApp**. Scan a QR code once and your
Luna agent reads and replies to WhatsApp — DMs and group @mentions — with
**cross-chat context** (it remembers what was said in another chat in the last
5 minutes / 30 messages).

Two parts:

| Part | Runtime | Role |
|---|---|---|
| **`gateway/`** — `luna-wa-gateway` | Node + [Baileys](https://github.com/WhiskeySockets/Baileys), deployed on Render (always-on) | Owns the WhatsApp Web socket, renders the QR, captures 100% of messages to Postgres, exposes `/send`. |
| **`plugin/`** — `plugin-whatsapp` | Python, loaded into your Luna | Receives signed inbound events, decides whether to answer, builds cross-chat context, runs the agent, sends the reply back through the gateway. |

The two talk over HTTPS, **HMAC-signed** with a shared secret. The gateway is the
only process that ever opens a WhatsApp socket; Luna sends by calling it.

```
WhatsApp ──socket── luna-wa-gateway (Render, 24/7) ──signed HTTP── plugin-whatsapp (your Luna)
                         │                                              │
                         └──────────────── Postgres ────────────────────
```

> **Baileys is unofficial WhatsApp Web.** Use a **dedicated / spare number**, not
> your daily driver — accounts can get banned. See [Ban risk](#ban-risk).

---

## Quick start

### 0. Prereqs
- A **spare WhatsApp number** on a phone you can scan a QR with.
- A running **Luna** with the plugin-vault available.
- A **Render** account (for the always-on gateway) — or any always-on Docker host.
- Two secrets:
  ```bash
  export WA_SHARED_SECRET=$(openssl rand -hex 32)   # gateway <-> plugin HMAC
  export GATEWAY_ADMIN_KEY=$(openssl rand -hex 16)   # protects the /qr page
  ```

### 1. Deploy the gateway to Render
1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml`:
   a `luna-wa-gateway` web service (with a 1 GB persistent disk for Baileys auth)
   + a `luna-wa-db` Postgres.
3. Set these env vars on the service (Dashboard → Environment):
   - `WA_SHARED_SECRET` — the value from step 0.
   - `GATEWAY_ADMIN_KEY` — the value from step 0.
   - `LUNA_INBOUND_URL` — where your Luna receives inbound:
     `https://<your-luna-host>/api/p/plugin-whatsapp/inbound`
     (running Luna locally? expose it with a tunnel — see [Local Luna](#local-luna).)
   - `DATABASE_URL` is wired automatically from `luna-wa-db`.
4. Deploy. When live, open:
   `https://luna-wa-gateway.onrender.com/health` → should show `status:"ok"`.

### 2. Link WhatsApp (scan the QR)
Open **`https://luna-wa-gateway.onrender.com/qr?key=<GATEWAY_ADMIN_KEY>`**.
On the spare phone: **WhatsApp → Settings → Linked Devices → Link a device**, scan
the QR. The page flips to “✓ Linked”. Auth persists on the disk — no re-scan on
restarts.

### 3. Install the plugin into Luna
Copy `plugin/plugin_whatsapp/` into your Luna's plugins directory (or package +
install from a marketplace). Set on the **Luna** side:
```bash
LUNA_WHATSAPP_GATEWAY_URL=https://luna-wa-gateway.onrender.com
LUNA_WHATSAPP_SHARED_SECRET=<same WA_SHARED_SECRET>
# optional:
LUNA_WHATSAPP_ALLOWLIST=+15551234567,+15559876543   # empty = answer all DMs
LUNA_WHATSAPP_GATEWAY_ADMIN_KEY=<GATEWAY_ADMIN_KEY>  # to show the QR in Luna settings
```
Restart Luna. The **WhatsApp** settings tab appears; `wa_*` tools are available.

### 4. Test
- DM the spare number from another phone → Luna replies on WhatsApp.
- In a group, `@mention` the number → Luna replies; non-mention messages are saved
  (for context) but not answered.
- Cross-chat: say something in group A, then in group B (within 5 min) ask “what
  did I just say about X?” → Luna answers from the injected context.

---

## Local Luna

Running Luna on your laptop (`:3000`)? The Render gateway must reach it. Expose it:
```bash
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```
Set the gateway's `LUNA_INBOUND_URL` to `https://<tunnel>/api/p/plugin-whatsapp/inbound`.
Outbound (Luna → gateway) needs no tunnel.

---

## Configuration

### Gateway (`gateway/.env.example`)
| Var | Required | Meaning |
|---|---|---|
| `WA_SHARED_SECRET` | ✅ | HMAC secret shared with the plugin |
| `GATEWAY_ADMIN_KEY` | ✅ | protects `/qr` |
| `LUNA_INBOUND_URL` | ✅ (to reply) | plugin inbound URL |
| `DATABASE_URL` | ✅ | Postgres |
| `WA_AUTH_DIR` | – | Baileys auth dir (Render disk) |
| `WA_SEND_DAILY_CAP` | – | per-day send cap (default 300) |

### Plugin (env / vault)
| Var | Required | Meaning |
|---|---|---|
| `LUNA_WHATSAPP_GATEWAY_URL` | ✅ | gateway base URL |
| `LUNA_WHATSAPP_SHARED_SECRET` | ✅ | same as `WA_SHARED_SECRET` (or vault key `plugin_whatsapp.shared_secret`) |
| `LUNA_WHATSAPP_ALLOWLIST` | – | comma-separated E.164; empty = all DMs |
| `LUNA_WHATSAPP_GATEWAY_ADMIN_KEY` | – | to proxy the QR page inside Luna settings |

---

## Local development

```bash
# Gateway
cd gateway
cp .env.example .env      # fill in secrets + a local Postgres URL
npm install
npm start                 # boots Baileys + serves /health /qr /send

# Plugin tests
cd plugin
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install -e ".[dev]"
pytest -q
```

---

## Ban risk

Baileys is the unofficial WhatsApp Web protocol. To reduce the chance of a ban:
- **Dedicated number**, never your personal daily one.
- Allowlist-first; the gateway caps sends per day and adds jitter.
- Keep volume human. For compliance/scale, migrate to the official WhatsApp
  Business Cloud API (documented fallback — groups aren't supported there).

## How it works (deeper)

- **100% capture:** every inbound + outbound is written to Postgres *before* any
  agent decision, keyed by `wa_msg_id` (idempotent). A Luna restart never loses or
  double-answers a message.
- **Activation:** DMs answered if the sender is allowlisted (or the allowlist is
  empty); groups require an @mention or reply-to-bot. Non-triggering messages are
  still captured and feed context.
- **Cross-chat context:** on every triggered turn the plugin injects the union of
  (last 5 min) and (last 30 messages) across all chats, attributed
  `[chat · sender · t-Δ ago]`, plus the `wa_context` tool for on-demand pulls.
- **Reply path:** the plugin runs a headless `ctx.agent.run_turn`, then sends the
  returned text through the gateway’s signed `/send` — exactly one reply.

See `../luna-plugins/plans/whatsapp/MVP-BUILD.md` for the full design and the
Phase-2 multi-tenant (hosted luna-service) plan.

## License

MIT — see [LICENSE](LICENSE).
