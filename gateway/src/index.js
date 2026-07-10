// wa-gateway HTTP surface (003 multi-Luna):
//   public:    /health
//   admin:     /qr (legacy alias), /stats, /accounts CRUD + per-account QR
//   HMAC:      /send, /send-media, /react — resolved to an account by secret
//              (or the x-wa-account header), so each Luna can only send
//              through its own number.
// Boots Postgres schema + one Baileys session per registered account.

import express from 'express';
import QRCode from 'qrcode';
import { createRequire } from 'module';

import { config } from './config.js';
import {
  initSchema, getAccount, listAccounts, getMessageStats, getAccountMessageStats,
} from './db.js';
import { buildStatsPayload, buildAccountsBreakdown } from './stats.js';
import {
  loadAll, getSession, allSessions, createAccount, patchAccount, deleteAccount,
  resolveSession, validAccountId,
} from './accounts.js';

const pkg = createRequire(import.meta.url)('../package.json');

const app = express();

// Stash the raw body so we can HMAC-verify signed requests. Media payloads
// (base64) can be large, so lift the default 100kb JSON limit.
app.use(
  express.json({
    limit: '25mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);

function requireAdmin(req, res) {
  const key = req.query.key || req.header('x-admin-key');
  if (key !== config.adminKey) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Resolve the sending session from the request's HMAC (see accounts.js).
// Wrong/unknown secret and explicit-but-mismatched x-wa-account both 401.
function requireAccount(req, res) {
  const session = resolveSession(req);
  if (!session) {
    res.status(401).json({ error: 'bad signature' });
    return null;
  }
  return session;
}

app.get('/health', async (_req, res) => {
  // Global liveness + a per-gateway summary. Top-level status/connected mirror
  // the `default` account for pre-003 consumers (plugin wa_status, monitors).
  const sessions = allSessions();
  const def = getSession(config.account);
  const conn = def?.getConnState()
    ?? { status: sessions.length ? 'multi' : 'no_accounts', connected: false };
  let sentToday = 0;
  try {
    const acc = await getAccount(config.account);
    sentToday = acc?.sent_today ?? 0;
  } catch {}
  res.json({
    status: 'ok',
    ...conn,
    sent_today: sentToday,
    gateway_id: config.gatewayId,
    accounts_total: sessions.length,
    accounts_connected: sessions.filter((s) => s.getConnState().connected).length,
  });
});

// ---------------------------------------------------------------------------
// QR pages
// ---------------------------------------------------------------------------

async function renderQrHtml(res, session, accountId) {
  const conn = session?.getConnState() ?? { status: 'no_such_account', connected: false };
  const qr = session?.getQr();
  let qrImg = '';
  if (qr) {
    try {
      qrImg = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    } catch {}
  }
  const linked = conn.connected;
  // WhatsApp dark-mode palette (bg #0b141a, card #202c33, green #00a884) so
  // the page looks native both standalone and embedded in the plugin's
  // settings iframe.
  res.set('content-type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Link WhatsApp — Luna</title>
<meta http-equiv="refresh" content="5">
<style>
  body{font-family:-apple-system,sans-serif;background:#0b141a;color:#e9edef;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;margin:0;text-align:center;padding:24px}
  .card{background:#202c33;border:1px solid #2a3942;border-radius:16px;padding:32px;max-width:420px}
  img{border-radius:12px;background:#fff;padding:12px}
  .ok{color:#00a884;font-size:20px;font-weight:600}
  p{color:#8696a0}
  b{color:#e9edef}
  code{background:#111b21;padding:2px 6px;border-radius:6px;color:#e9edef}
  .status{color:#8696a0;font-size:13px;margin-top:16px}
</style></head><body><div class="card">
  <h2>Link WhatsApp to Luna</h2>
  <p class="status">account: <code>${accountId}</code></p>
  ${linked
    ? `<p class="ok">✓ Linked and connected</p><p>as <code>${conn.self_jid || ''}</code></p>`
    : qrImg
      ? `<p>Open WhatsApp → <b>Linked Devices</b> → <b>Link a device</b>, then scan:</p><img src="${qrImg}" alt="QR"/>`
      : `<p>Waiting for a QR code… (status: <code>${conn.status}</code>)</p>`}
  <p class="status">Auto-refreshes every 5s · status: ${conn.status}</p>
</div></body></html>`);
}

// Legacy QR page — alias for the default account.
app.get('/qr', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await renderQrHtml(res, getSession(config.account), config.account);
});

// ---------------------------------------------------------------------------
// admin API: account lifecycle (what luna-service's control plane calls)
// ---------------------------------------------------------------------------

function accountView(row, session) {
  const live = session?.getConnState();
  let inboundHost = null;
  try {
    inboundHost = row.inbound_url ? new URL(row.inbound_url).host : null;
  } catch {}
  return {
    account_id: row.account_id,
    status: live?.status ?? row.status,
    connected: live ? live.connected : false,
    self_jid: live?.self_jid ?? row.self_jid ?? null,
    has_qr: live?.has_qr ?? false,
    inbound_host: inboundHost,
    sent_today: row.sent_today ?? 0,
    daily_cap: row.daily_cap ?? config.sendDailyCap,
    last_seen: row.last_seen instanceof Date ? row.last_seen.toISOString() : row.last_seen,
    enabled: row.enabled !== false,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

app.post('/accounts', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { account_id, inbound_url, daily_cap } = req.body || {};
  if (!validAccountId(account_id)) {
    return res.status(400).json({ error: 'account_id required: ^[a-z0-9][a-z0-9._-]{0,63}$' });
  }
  try {
    const { row, secret, created } = await createAccount({ account_id, inbound_url, daily_cap });
    res.status(created ? 201 : 200).json({
      ...accountView(row, getSession(account_id)),
      secret,
      qr_url: `/accounts/${account_id}/qr`,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/accounts', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = await listAccounts({ includeDisabled: req.query.all === '1' });
  res.json({ accounts: rows.map((r) => accountView(r, getSession(r.account_id))) });
});

app.get('/accounts/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = await getAccount(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such account' });
  res.json(accountView(row, getSession(row.account_id)));
});

app.get('/accounts/:id/qr', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = await getAccount(req.params.id);
  if (!row || !row.enabled) return res.status(404).json({ error: 'no such account' });
  const session = getSession(row.account_id);
  const format = req.query.format || 'html';
  if (format === 'json') {
    const conn = session?.getConnState() ?? { status: row.status, connected: false };
    return res.json({ ...conn, account_id: row.account_id, qr: session?.getQr() ?? null });
  }
  if (format === 'png') {
    const qr = session?.getQr();
    if (!qr) return res.status(404).json({ error: 'no QR pending', status: session?.status });
    const png = await QRCode.toBuffer(qr, { width: 320, margin: 2 });
    return res.set('content-type', 'image/png').send(png);
  }
  await renderQrHtml(res, session, row.account_id);
});

app.patch('/accounts/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { inbound_url, daily_cap, rotate_secret } = req.body || {};
  try {
    const result = await patchAccount(req.params.id, { inbound_url, daily_cap, rotate_secret });
    if (!result) return res.status(404).json({ error: 'no such account' });
    res.json({
      ...accountView(result.row, getSession(req.params.id)),
      ...(result.secret ? { secret: result.secret } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/accounts/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ok = await deleteAccount(req.params.id);
  if (!ok) return res.status(404).json({ error: 'no such account' });
  res.json({ ok: true, account_id: req.params.id });
});

// ---------------------------------------------------------------------------
// monitoring
// ---------------------------------------------------------------------------

// Monitoring endpoint for the luna-service WhatsApp page. Admin-key protected.
// Socket state still returns when Postgres is down, with db.ok=false — the
// page distinguishes "server up, DB down" from "server down". Top-level fields
// mirror the default account (pre-003 shape, frozen); accounts[] is the
// per-account breakdown.
app.get('/stats', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const def = getSession(config.account);
  const conn = def?.getConnState() ?? {
    status: 'no_accounts', connected: false, self_jid: null, has_qr: false,
    last_activity_at: new Date().toISOString(),
  };
  let state = null;
  let stats = null;
  let accounts = null;
  let dbLatencyMs = null;
  let dbError = null;
  try {
    const t0 = Date.now();
    const [defRow, msgStats, accountRows, per24] = await Promise.all([
      getAccount(config.account),
      getMessageStats(),
      listAccounts({ includeDisabled: true }),
      getAccountMessageStats(),
    ]);
    dbLatencyMs = Date.now() - t0;
    state = defRow;
    stats = msgStats;
    const liveStates = Object.fromEntries(
      allSessions().map((s) => [s.accountId, s.getConnState()]),
    );
    accounts = buildAccountsBreakdown(accountRows, liveStates, per24, config.sendDailyCap);
  } catch (e) {
    dbError = e.message;
  }
  res.json(buildStatsPayload({
    conn, state, stats, dbLatencyMs, dbError, accounts,
    cap: config.sendDailyCap, version: pkg.version,
  }));
});

// ---------------------------------------------------------------------------
// signed send/react (per-account)
// ---------------------------------------------------------------------------

// Resolution failures carry their own status (400 invalid target, 404 not on
// WhatsApp); anything else is the socket's fault → 502.
function sendErr(res, e) {
  res.status(e.status || 502).json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
}

function requireGroupJid(res, jid) {
  if (typeof jid === 'string' && jid.endsWith('@g.us')) return true;
  res.status(400).json({ ok: false, error: 'group_jid required (…@g.us)' });
  return false;
}

app.post('/send', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { chat_jid, text, reply_to } = req.body || {};
  if (!chat_jid || !text) {
    return res.status(400).json({ error: 'chat_jid and text required' });
  }
  try {
    const jid = await session.resolveJid(chat_jid);
    const result = await session.sendText(jid, text, reply_to);
    res.json({ ok: true, account: session.accountId, chat_jid: jid, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

// Send media (image/video/audio/document/sticker). The plugin supplies EITHER a
// public `url` the gateway can fetch, OR inline `data_base64` bytes (for assets
// only reachable inside Luna, e.g. a browser screenshot).
app.post('/send-media', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const {
    chat_jid, kind = 'image', url, data_base64,
    caption, mimetype, file_name, reply_to,
    ptt, gif_playback, ptv,
  } = req.body || {};
  if (!chat_jid || (!url && !data_base64)) {
    return res.status(400).json({ error: 'chat_jid and one of url|data_base64 required' });
  }
  try {
    let source;
    if (data_base64) {
      source = Buffer.from(data_base64, 'base64');
    } else if (/^https?:\/\//i.test(url)) {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`fetch media ${r.status}`);
      source = Buffer.from(await r.arrayBuffer());
    } else {
      // A local path — hand straight to Baileys' url loader.
      source = url;
    }
    const jid = await session.resolveJid(chat_jid);
    const result = await session.sendMedia(jid, kind, source, {
      caption, mimetype, fileName: file_name, replyToWaId: reply_to,
      ptt, gifPlayback: gif_playback, ptv,
    });
    res.json({ ok: true, account: session.accountId, chat_jid: jid, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/react', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { chat_jid, wa_msg_id, emoji } = req.body || {};
  if (!chat_jid || !wa_msg_id || !emoji) {
    return res.status(400).json({ error: 'chat_jid, wa_msg_id, emoji required' });
  }
  try {
    const jid = await session.resolveJid(chat_jid);
    const result = await session.react(jid, wa_msg_id, emoji);
    res.json({ account: session.accountId, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

// ---------------------------------------------------------------------------
// signed resolve + group management (per-account)
// All POST so the HMAC covers the JSON body uniformly.
// ---------------------------------------------------------------------------

// Resolve a phone number / loose JID to a canonical WhatsApp JID (verifies
// registration via onWhatsApp for bare numbers).
app.post('/resolve', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { target } = req.body || {};
  if (!target) return res.status(400).json({ error: 'target required' });
  try {
    const jid = await session.resolveJid(target);
    res.json({ ok: true, jid, kind: jid.endsWith('@g.us') ? 'group' : 'dm' });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/list', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  try {
    res.json({ ok: true, groups: await session.listGroups() });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/info', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { group_jid } = req.body || {};
  if (!requireGroupJid(res, group_jid)) return;
  try {
    res.json({ ok: true, group: await session.groupInfo(group_jid) });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/subject', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { group_jid, subject } = req.body || {};
  if (!requireGroupJid(res, group_jid)) return;
  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ ok: false, error: 'subject required' });
  }
  try {
    const result = await session.groupRename(group_jid, subject);
    res.json({ ok: true, account: session.accountId, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/participants', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { group_jid, action, participants } = req.body || {};
  if (!requireGroupJid(res, group_jid)) return;
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ ok: false, error: 'participants (non-empty array) required' });
  }
  try {
    const result = await session.groupParticipants(group_jid, action, participants);
    res.json({ ok: true, account: session.accountId, action, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/create', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { subject, participants } = req.body || {};
  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ ok: false, error: 'subject required' });
  }
  try {
    const group = await session.groupCreate(subject, participants || []);
    res.json({ ok: true, account: session.accountId, group });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/leave', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { group_jid } = req.body || {};
  if (!requireGroupJid(res, group_jid)) return;
  try {
    const result = await session.groupLeave(group_jid);
    res.json({ ok: true, account: session.accountId, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/groups/invite', async (req, res) => {
  const session = requireAccount(req, res);
  if (!session) return;
  const { group_jid } = req.body || {};
  if (!requireGroupJid(res, group_jid)) return;
  try {
    const result = await session.groupInvite(group_jid);
    res.json({ ok: true, account: session.accountId, ...result });
  } catch (e) {
    sendErr(res, e);
  }
});

async function main() {
  await initSchema();
  await loadAll();
  app.listen(config.port, () => {
    console.log(`[gateway] listening on :${config.port} (gateway ${config.gatewayId})`);
    console.log(`[gateway] QR page: /qr?key=<GATEWAY_ADMIN_KEY> · accounts API: /accounts`);
  });
}

main().catch((e) => {
  console.error('[gateway] fatal:', e);
  process.exit(1);
});
