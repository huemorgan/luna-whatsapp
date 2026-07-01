// wa-gateway HTTP surface: /health, /qr (scan page), /send, /react.
// Boots Postgres schema + the Baileys session, then serves.

import express from 'express';
import QRCode from 'qrcode';

import { config } from './config.js';
import { verify } from './hmac.js';
import { initSchema, getState } from './db.js';
import { startSession, getConnState, getQr, sendText, react } from './wa.js';

const app = express();

// Stash the raw body so we can HMAC-verify signed requests.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);

function requireHmac(req, res) {
  const ts = req.header('x-wa-timestamp');
  const sig = req.header('x-wa-signature');
  if (!verify(config.sharedSecret, req.rawBody || '', ts, sig)) {
    res.status(401).json({ error: 'bad signature' });
    return false;
  }
  return true;
}

app.get('/health', async (_req, res) => {
  const conn = getConnState();
  let sentToday = 0;
  try {
    const st = await getState();
    sentToday = st?.sent_today ?? 0;
  } catch {}
  res.json({ status: 'ok', ...conn, sent_today: sentToday });
});

app.get('/qr', async (req, res) => {
  if (req.query.key !== config.adminKey) {
    return res.status(401).send('unauthorized');
  }
  const conn = getConnState();
  const qr = getQr();
  let qrImg = '';
  if (qr) {
    try {
      qrImg = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    } catch {}
  }
  const linked = conn.connected;
  res.set('content-type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Link WhatsApp — Luna</title>
<meta http-equiv="refresh" content="5">
<style>
  body{font-family:-apple-system,sans-serif;background:#0f0f1e;color:#e0e0e0;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;margin:0;text-align:center;padding:24px}
  .card{background:#1a1a2e;border-radius:16px;padding:32px;max-width:420px}
  img{border-radius:12px;background:#fff;padding:12px}
  .ok{color:#4ade80;font-size:20px;font-weight:600}
  code{background:#2a2a3e;padding:2px 6px;border-radius:6px}
  .status{opacity:.6;font-size:13px;margin-top:16px}
</style></head><body><div class="card">
  <h2>Link WhatsApp to Luna</h2>
  ${linked
    ? `<p class="ok">✓ Linked and connected</p><p>as <code>${conn.self_jid || ''}</code></p>`
    : qrImg
      ? `<p>Open WhatsApp → <b>Linked Devices</b> → <b>Link a device</b>, then scan:</p><img src="${qrImg}" alt="QR"/>`
      : `<p>Waiting for a QR code… (status: <code>${conn.status}</code>)</p>`}
  <p class="status">Auto-refreshes every 5s · status: ${conn.status}</p>
</div></body></html>`);
});

app.post('/send', async (req, res) => {
  if (!requireHmac(req, res)) return;
  const { chat_jid, text, reply_to } = req.body || {};
  if (!chat_jid || !text) {
    return res.status(400).json({ error: 'chat_jid and text required' });
  }
  try {
    const result = await sendText(chat_jid, text, reply_to);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/react', async (req, res) => {
  if (!requireHmac(req, res)) return;
  const { chat_jid, wa_msg_id, emoji } = req.body || {};
  if (!chat_jid || !wa_msg_id || !emoji) {
    return res.status(400).json({ error: 'chat_jid, wa_msg_id, emoji required' });
  }
  try {
    const result = await react(chat_jid, wa_msg_id, emoji);
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

async function main() {
  await initSchema();
  await startSession();
  app.listen(config.port, () => {
    console.log(`[gateway] listening on :${config.port}`);
    console.log(`[gateway] QR page: /qr?key=<GATEWAY_ADMIN_KEY>`);
  });
}

main().catch((e) => {
  console.error('[gateway] fatal:', e);
  process.exit(1);
});
