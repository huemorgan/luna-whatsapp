// The Baileys WhatsApp Web session: the single always-on owner of the socket.
// Owns connect, QR, reconnect watchdog, 100% capture, send/react. Everything
// else in the gateway talks THROUGH this module — nothing else opens a socket.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

import { config } from './config.js';
import { insertMessage, upsertChat, setState, bumpSendCounter } from './db.js';
import { forwardInbound } from './inbound.js';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

let sock = null;
let status = 'starting';
let selfJid = null;
let selfNumber = null;
let currentQr = null;
let lastActivityAt = Date.now();
let reconnecting = false;

export function getConnState() {
  return {
    status,
    connected: status === 'open',
    self_jid: selfJid,
    has_qr: !!currentQr,
    last_activity_at: new Date(lastActivityAt).toISOString(),
  };
}

export function getQr() {
  return currentQr;
}

function markActivity() {
  lastActivityAt = Date.now();
}

// Presence ("typing…"/"recording…") indicator. Safe no-op if not connected.
export async function setPresence(type, jid) {
  if (!sock || status !== 'open') return;
  try {
    await sock.sendPresenceUpdate(type, jid);
  } catch (e) {
    console.error('[wa] presence %s failed:', type, e.message);
  }
}

// Run `fn` while showing a live typing indicator in `jid`. Baileys' 'composing'
// state auto-expires (~10s), so we re-assert it on an interval until fn settles,
// then send 'paused'. Never lets a presence error break the wrapped work.
export async function withComposing(jid, fn) {
  await setPresence('composing', jid);
  const keepalive = setInterval(() => { void setPresence('composing', jid); }, 8000);
  try {
    return await fn();
  } finally {
    clearInterval(keepalive);
    await setPresence('paused', jid);
  }
}

function chatKind(jid) {
  return jid?.endsWith('@g.us') ? 'group' : 'dm';
}

function normalizeNumber(jid) {
  if (!jid) return null;
  return jid.split(':')[0].split('@')[0];
}

function extractContent(message) {
  const m = message.message;
  if (!m) return { kind: 'system', body: null };
  if (m.conversation) return { kind: 'text', body: m.conversation };
  if (m.extendedTextMessage?.text) return { kind: 'text', body: m.extendedTextMessage.text };
  if (m.imageMessage) return { kind: 'image', body: m.imageMessage.caption || '' };
  if (m.videoMessage) return { kind: 'video', body: m.videoMessage.caption || '' };
  if (m.audioMessage) return { kind: 'audio', body: '' };
  if (m.documentMessage) return { kind: 'doc', body: m.documentMessage.fileName || '' };
  if (m.stickerMessage) return { kind: 'sticker', body: '' };
  if (m.contactMessage) return { kind: 'contact', body: m.contactMessage.displayName || '' };
  if (m.locationMessage) return { kind: 'location', body: '' };
  return { kind: 'other', body: null };
}

function contextInfoOf(message) {
  const m = message.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    null
  );
}

// Group subject cache so cross-chat context shows names, not raw JIDs. TTL keeps
// it fresh if a group is renamed; groups.update also busts individual entries.
const groupNameCache = new Map(); // jid -> { name, at }
const GROUP_NAME_TTL_MS = 60 * 60 * 1000;

async function resolveGroupName(jid) {
  const hit = groupNameCache.get(jid);
  if (hit && Date.now() - hit.at < GROUP_NAME_TTL_MS) return hit.name;
  try {
    const meta = await sock.groupMetadata(jid);
    const name = meta?.subject || null;
    groupNameCache.set(jid, { name, at: Date.now() });
    return name;
  } catch {
    // Cache the miss briefly so we don't hammer groupMetadata on every message.
    groupNameCache.set(jid, { name: hit?.name ?? null, at: Date.now() });
    return hit?.name ?? null;
  }
}

async function handleMessage(message, isNotify) {
  const chatJid = message.key.remoteJid;
  if (!chatJid || chatJid === 'status@broadcast') return;

  const fromMe = !!message.key.fromMe;
  const kind = chatKind(chatJid);
  const senderJid = kind === 'group'
    ? (message.key.participant || null)
    : (fromMe ? selfJid : chatJid);
  const { kind: msgKind, body } = extractContent(message);
  const ctxInfo = contextInfoOf(message);
  const replyToId = ctxInfo?.stanzaId || null;
  const mentionedJids = ctxInfo?.mentionedJid || [];
  const ts = message.messageTimestamp
    ? new Date(Number(message.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();

  // Group subject (resolved + cached); DMs use the contact push name.
  const chatName = kind === 'group'
    ? await resolveGroupName(chatJid)
    : (message.pushName || null);

  const row = {
    account: config.account,
    chat_jid: chatJid,
    chat_kind: kind,
    chat_name: chatName,
    sender_jid: senderJid,
    sender_name: message.pushName || null,
    from_me: fromMe,
    wa_msg_id: message.key.id || null,
    reply_to_id: replyToId,
    ts,
    kind: msgKind,
    body,
    media_path: null,
    raw: { key: message.key, pushName: message.pushName, mentionedJids },
  };

  // 100% capture — before any decision, idempotent on wa_msg_id.
  await insertMessage(row).catch((e) => console.error('[wa] insert failed:', e.message));
  await upsertChat({ chat_jid: chatJid, chat_kind: kind, chat_name: row.chat_name }).catch(() => {});

  // Only forward genuinely-new inbound (not our own, not history sync) to Luna.
  if (fromMe || !isNotify) return;

  const mentionedMe =
    selfNumber && mentionedJids.some((j) => normalizeNumber(j) === selfNumber);
  const isReplyToMe =
    selfNumber && ctxInfo?.participant && normalizeNumber(ctxInfo.participant) === selfNumber;

  // Show the WhatsApp "typing…" indicator for the whole time Luna is thinking,
  // then clear it. Baileys' composing state expires after ~10s, so keep it alive.
  await withComposing(chatJid, () =>
    forwardInbound({
      account: config.account,
      chat_jid: chatJid,
      chat_kind: kind,
      chat_name: row.chat_name,
      sender_jid: senderJid,
      sender_name: message.pushName || null,
      wa_msg_id: message.key.id,
      reply_to_id: replyToId,
      ts,
      kind: msgKind,
      body,
      mentioned_me: !!mentionedMe,
      is_reply_to_me: !!isReplyToMe,
    }),
  );
}

export async function startSession() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Luna WhatsApp', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: config.keepAliveIntervalMs,
    connectTimeoutMs: config.connectTimeoutMs,
    defaultQueryTimeoutMs: config.defaultQueryTimeoutMs,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    markActivity();
    if (qr) {
      currentQr = qr;
      status = 'linking';
      await setState({ status: 'linking' }).catch(() => {});
      console.log('[wa] QR ready — open /qr to scan');
    }
    if (connection === 'open') {
      status = 'open';
      currentQr = null;
      selfJid = sock.user?.id || null;
      selfNumber = normalizeNumber(selfJid);
      await setState({
        status: 'open',
        self_jid: selfJid,
        last_seen: new Date().toISOString(),
      }).catch(() => {});
      console.log('[wa] connection open as', selfJid);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      status = loggedOut ? 'logged_out' : 'disconnected';
      await setState({ status }).catch(() => {});
      console.log('[wa] connection closed. code=%s loggedOut=%s', code, loggedOut);
      if (!loggedOut) scheduleReconnect();
      else console.log('[wa] logged out — re-link required (delete auth dir + rescan)');
    }
  });

  // A group rename/metadata change invalidates the cached subject.
  sock.ev.on('groups.update', (updates) => {
    for (const u of updates || []) {
      if (u?.id) groupNameCache.delete(u.id);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    markActivity();
    const isNotify = type === 'notify';
    for (const message of messages) {
      try {
        await handleMessage(message, isNotify);
      } catch (e) {
        console.error('[wa] handleMessage error:', e.message);
      }
    }
  });

  startWatchdog();
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(async () => {
    reconnecting = false;
    try {
      console.log('[wa] reconnecting…');
      await startSession();
    } catch (e) {
      console.error('[wa] reconnect failed:', e.message);
      scheduleReconnect();
    }
  }, 3000);
}

let watchdogTimer = null;
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    const idle = Date.now() - lastActivityAt;
    await setState({ last_seen: new Date().toISOString() }).catch(() => {});
    // Zombie-socket backstop: looks "open" but no activity for too long.
    if (status === 'open' && idle > config.appSilenceBackstopMs) {
      console.log('[wa] watchdog: %dms idle, forcing reconnect', idle);
      try {
        sock?.end?.(new Error('watchdog forced reconnect'));
      } catch {}
      status = 'disconnected';
      scheduleReconnect();
    }
  }, 30000);
}

export async function sendText(chatJid, text, replyToWaId) {
  if (!sock || status !== 'open') throw new Error('WhatsApp socket not connected');
  const allowed = await bumpSendCounter(config.sendDailyCap);
  if (!allowed) throw new Error('daily send cap reached');
  // Light jitter to look less bot-like (ban-risk guard).
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  const options = {};
  if (replyToWaId) {
    options.quoted = { key: { remoteJid: chatJid, id: replyToWaId }, message: {} };
  }
  const sent = await sock.sendMessage(chatJid, { text }, options);
  return { wa_msg_id: sent?.key?.id || null };
}

// Turn an inbound media source into a Baileys WAMediaUpload. Accepts a Buffer,
// a public http(s) URL (Baileys streams it), or a local file path.
export function toMediaUpload(source) {
  if (Buffer.isBuffer(source)) return source;
  if (typeof source === 'string') return { url: source };
  throw new Error('media source must be a Buffer or a url/path string');
}

// Build the Baileys message-content object for a media kind. Pure (no socket),
// so it's unit-testable in isolation.
export function buildMediaContent(mediaKind, media, opts = {}) {
  switch (mediaKind) {
    case 'image':
      return { image: media, caption: opts.caption || undefined };
    case 'video':
      return {
        video: media,
        caption: opts.caption || undefined,
        gifPlayback: !!opts.gifPlayback,
        ptv: !!opts.ptv,
      };
    case 'audio':
      return {
        audio: media,
        mimetype: opts.mimetype || 'audio/ogg; codecs=opus',
        ptt: opts.ptt ?? true,
      };
    case 'document':
      return {
        document: media,
        mimetype: opts.mimetype || 'application/octet-stream',
        fileName: opts.fileName || 'file',
        caption: opts.caption || undefined,
      };
    case 'sticker':
      return { sticker: media };
    default:
      throw new Error(`unsupported media kind: ${mediaKind}`);
  }
}

// Send any media kind (image/video/audio/document/sticker). Reuses the same
// send-cap + jitter guards as text so ban-risk pacing is identical.
export async function sendMedia(chatJid, mediaKind, source, opts = {}) {
  if (!sock || status !== 'open') throw new Error('WhatsApp socket not connected');
  const allowed = await bumpSendCounter(config.sendDailyCap);
  if (!allowed) throw new Error('daily send cap reached');
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));

  const options = {};
  if (opts.replyToWaId) {
    options.quoted = { key: { remoteJid: chatJid, id: opts.replyToWaId }, message: {} };
  }

  const media = toMediaUpload(source);
  const content = buildMediaContent(mediaKind, media, opts);
  const sent = await sock.sendMessage(chatJid, content, options);
  return { wa_msg_id: sent?.key?.id || null };
}

export async function react(chatJid, waMsgId, emoji) {
  if (!sock || status !== 'open') throw new Error('WhatsApp socket not connected');
  await sock.sendMessage(chatJid, {
    react: { text: emoji, key: { remoteJid: chatJid, id: waMsgId } },
  });
  return { ok: true };
}
