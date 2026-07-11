// One Baileys session = one account = one WhatsApp number = one Luna instance.
// Pre-003 this file's state lived as module singletons in wa.js; the class
// scope is what makes N sessions possible (and fixes the latent bug where a
// module-global watchdog guard would have silently disabled watchdogs for
// every session after the first).
//
// Pure helpers (parseReaction, buildMediaContent, …) stay module-level exports
// so they remain unit-testable without a socket.

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'node:path';

import { config } from './config.js';
import { insertMessage, upsertChat, updateAccount, bumpSendCounter } from './db.js';
import { forwardInbound } from './inbound.js';

const LOG_LEVEL = process.env.WA_LOG_LEVEL || 'warn';

// Restriction signals WhatsApp surfaces only inside Baileys' own log stream
// (there is no event for them): "error 463: account restricted or missing
// tctoken for contact" preceded both device removals on 2026-07-10/11. Pure so
// it's unit-testable; wired into a per-session pino hook in start().
export function detectRestrictionSignal(args) {
  try {
    const text = (args || [])
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    return /account restricted|missing tctoken|error 463|device_removed/i.test(text);
  } catch {
    return false;
  }
}

// Per-account device fingerprint so N accounts on one gateway don't present
// identical clients. Deterministic (stable across restarts — a changed tuple
// shows up as a "new device"); `default` keeps the pre-006 tuple so the
// already-linked number never sees a device change.
const BROWSER_TUPLES = [
  ['Luna WhatsApp', 'Chrome', '1.0.0'],
  ['Luna', 'Safari', '17.4'],
  ['Luna Desktop', 'Edge', '120.0'],
  ['Luna Web', 'Firefox', '125.0'],
];
export function pickBrowser(accountId) {
  if (accountId === 'default') return BROWSER_TUPLES[0];
  let h = 0;
  for (const ch of String(accountId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BROWSER_TUPLES[h % BROWSER_TUPLES.length];
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

export function chatKind(jid) {
  return jid?.endsWith('@g.us') ? 'group' : 'dm';
}

export function normalizeNumber(jid) {
  if (!jid) return null;
  return jid.split(':')[0].split('@')[0];
}

export function digitsOf(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

// Classify a loose send target without a socket. The plugin (and the agent
// behind it) may pass a full JID, a phone number in any human format
// ("+972 54-123-4567"), or garbage. Returns:
//   { jid }    — already a sendable JID (groups/lid pass through; phone JIDs
//                are canonicalized: device suffix and non-digits stripped)
//   { number } — looks like a phone number; needs an onWhatsApp resolution
//   null       — not a valid target
export function normalizeTarget(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/@(g\.us|lid|newsletter|broadcast)$/.test(s)) return { jid: s };
  if (s.endsWith('@s.whatsapp.net')) {
    const digits = digitsOf(normalizeNumber(s));
    return digits.length >= 5 ? { jid: `${digits}@s.whatsapp.net` } : null;
  }
  if (s.includes('@')) return null; // unknown JID domain — refuse loudly
  const digits = digitsOf(s);
  return digits.length >= 5 && digits.length <= 20 ? { number: digits } : null;
}

// Shape Baileys group metadata into the wire form the plugin exposes to the
// agent. Pure (no socket) so it stays unit-testable.
export function shapeGroupMeta(meta, selfNumber) {
  const participants = (meta?.participants || []).map((p) => ({
    jid: p.id,
    admin: p.admin || null,
  }));
  const meAdmin = participants.some(
    (p) => selfNumber && normalizeNumber(p.jid) === selfNumber && p.admin,
  );
  return {
    jid: meta?.id ?? null,
    subject: meta?.subject || null,
    description: meta?.desc || null,
    owner: meta?.owner || null,
    created_at: meta?.creation ? new Date(Number(meta.creation) * 1000).toISOString() : null,
    announce: !!meta?.announce,
    participants_count: participants.length,
    participants,
    me_admin: meAdmin,
  };
}

export const GROUP_PARTICIPANT_ACTIONS = ['add', 'remove', 'promote', 'demote'];

export function extractContent(message) {
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

export function contextInfoOf(message) {
  const m = message.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    null
  );
}

// Decide whether a Baileys reaction entry should be forwarded, and shape it into
// an inbound envelope (minus chat_name, which needs an async group lookup).
// Returns null to drop the reaction. We forward ONLY reactions to messages WE
// sent — "the user liked something Luna wrote" — so the agent can see it.
export function parseReaction(entry, { account } = {}) {
  const targetKey = entry?.key || {};
  const reaction = entry?.reaction || {};
  const chatJid = targetKey.remoteJid;
  if (!chatJid || chatJid === 'status@broadcast') return null;

  const emoji = (reaction.text || '').trim();
  if (!emoji) return null;                 // reaction removed
  const reactorKey = reaction.key || {};
  if (reactorKey.fromMe) return null;      // our own reaction
  if (!targetKey.fromMe) return null;      // not a reaction to OUR message

  const kind = chatKind(chatJid);
  const reactorJid = kind === 'group' ? (reactorKey.participant || null) : chatJid;
  return {
    account: account ?? null,
    chat_jid: chatJid,
    chat_kind: kind,
    chat_name: null,
    sender_jid: reactorJid,
    sender_name: null,               // reaction events don't carry a push name
    wa_msg_id: reactorKey.id || `react-${targetKey.id}-${emoji}`,
    reply_to_id: targetKey.id,       // the message that was reacted to
    ts: new Date().toISOString(),
    kind: 'reaction',
    body: null,
    reaction_emoji: emoji,
    reaction_target_id: targetKey.id,
    reaction_target_from_me: true,
    mentioned_me: false,
    is_reply_to_me: true,            // a like on our msg counts as addressing us
  };
}

// Turn an inbound media source into a Baileys WAMediaUpload. Accepts a Buffer,
// a public http(s) URL (Baileys streams it), or a local file path.
export function toMediaUpload(source) {
  if (Buffer.isBuffer(source)) return source;
  if (typeof source === 'string') return { url: source };
  throw new Error('media source must be a Buffer or a url/path string');
}

// Build the Baileys message-content object for a media kind. Pure (no socket).
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

const GROUP_NAME_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  // row: a whatsapp_accounts registry row.
  constructor(row) {
    this.accountId = row.account_id;
    this.secret = row.secret;
    this.inboundUrl = row.inbound_url || '';
    this.dailyCap = row.daily_cap ?? config.sendDailyCap;
    this.authDir = path.join(config.authDir, this.accountId);

    this.sock = null;
    this.status = row.status === 'open' ? 'starting' : (row.status ?? 'starting');
    this.selfJid = row.self_jid ?? null;
    this.selfNumber = normalizeNumber(this.selfJid);
    this.currentQr = null;
    this.lastActivityAt = Date.now();
    this.reconnecting = false;
    this.stopped = false;
    this.watchdogTimer = null;
    this.groupNameCache = new Map(); // jid -> { name, at }

    // 006 anti-ban state (persisted on the registry row).
    this.proxyUrl = row.proxy_url || null;
    this.linkedAt = row.linked_at ? new Date(row.linked_at).getTime() : null;
    this.breakerUntil = row.breaker_until ? new Date(row.breaker_until).getTime() : null;
    this.breakerReason = row.breaker_reason || null;
    this.coldFreezeUntil = null; // derived on trip; conservative across restarts via breaker_until
    this._sawQr = false;         // a QR was displayed since the last open → next open is a (re)link
    this.outbox = null;          // OutboxWorker, attached by accounts.js
  }

  // ---- 006 breaker / warm-up ------------------------------------------------

  breakerOpen() {
    return !!this.breakerUntil && Date.now() < this.breakerUntil;
  }

  coldFrozen() {
    return this.breakerOpen()
      || (!!this.coldFreezeUntil && Date.now() < this.coldFreezeUntil);
  }

  inWarmup() {
    return !!this.linkedAt
      && Date.now() - this.linkedAt < config.warmupHours * 3600 * 1000;
  }

  // WhatsApp pushed back (463 restriction / device_removed / 401). Freeze
  // outbound and park the queue; nothing auto-fires when the window expires.
  tripBreaker(reason) {
    const now = Date.now();
    if (this.breakerOpen()) return; // already tripped — don't extend on every log line
    this.breakerUntil = now + config.breakerHours * 3600 * 1000;
    this.coldFreezeUntil = now + config.coldFreezeHours * 3600 * 1000;
    this.breakerReason = reason;
    console.error('[wa:%s] BREAKER TRIPPED (%s) — outbound frozen until %s',
      this.accountId, reason, new Date(this.breakerUntil).toISOString());
    void this.setAccountState({
      breaker_until: new Date(this.breakerUntil).toISOString(),
      breaker_reason: reason,
    });
    void this.outbox?.holdAll();
  }

  // Manual all-clear (admin /accounts/:id/outbox/release). Clears both the
  // breaker and the cold freeze; the caller re-queues held rows.
  async releaseBreaker() {
    this.breakerUntil = null;
    this.breakerReason = null;
    this.coldFreezeUntil = null;
    await this.setAccountState({ breaker_until: null, breaker_reason: null });
  }

  getConnState() {
    return {
      status: this.status,
      connected: this.status === 'open',
      self_jid: this.selfJid,
      has_qr: !!this.currentQr,
      last_activity_at: new Date(this.lastActivityAt).toISOString(),
    };
  }

  getQr() {
    return this.currentQr;
  }

  // Live registry updates (PATCH /accounts/{id}) — no session restart needed.
  updateRoute({ inbound_url, secret, daily_cap } = {}) {
    if (inbound_url !== undefined) this.inboundUrl = inbound_url || '';
    if (secret !== undefined) this.secret = secret;
    if (daily_cap !== undefined) this.dailyCap = daily_cap ?? config.sendDailyCap;
  }

  markActivity() {
    this.lastActivityAt = Date.now();
  }

  async setAccountState(patch) {
    await updateAccount(this.accountId, patch).catch(() => {});
  }

  // Presence ("typing…"/"recording…") indicator. Safe no-op if not connected.
  async setPresence(type, jid) {
    if (!this.sock || this.status !== 'open') return;
    try {
      await this.sock.sendPresenceUpdate(type, jid);
    } catch (e) {
      console.error('[wa:%s] presence %s failed:', this.accountId, type, e.message);
    }
  }

  // Run `fn` while showing a live typing indicator in `jid`. Baileys' 'composing'
  // state auto-expires (~10s), so we re-assert it on an interval until fn settles,
  // then send 'paused'. Never lets a presence error break the wrapped work.
  async withComposing(jid, fn) {
    await this.setPresence('composing', jid);
    const keepalive = setInterval(() => { void this.setPresence('composing', jid); }, 8000);
    try {
      return await fn();
    } finally {
      clearInterval(keepalive);
      await this.setPresence('paused', jid);
    }
  }

  async resolveGroupName(jid) {
    const hit = this.groupNameCache.get(jid);
    if (hit && Date.now() - hit.at < GROUP_NAME_TTL_MS) return hit.name;
    try {
      const meta = await this.sock.groupMetadata(jid);
      const name = meta?.subject || null;
      this.groupNameCache.set(jid, { name, at: Date.now() });
      return name;
    } catch {
      // Cache the miss briefly so we don't hammer groupMetadata on every message.
      this.groupNameCache.set(jid, { name: hit?.name ?? null, at: Date.now() });
      return hit?.name ?? null;
    }
  }

  async handleMessage(message, isNotify) {
    const chatJid = message.key.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return;

    const fromMe = !!message.key.fromMe;
    const kind = chatKind(chatJid);
    const senderJid = kind === 'group'
      ? (message.key.participant || null)
      : (fromMe ? this.selfJid : chatJid);
    const { kind: msgKind, body } = extractContent(message);
    const ctxInfo = contextInfoOf(message);
    const replyToId = ctxInfo?.stanzaId || null;
    const mentionedJids = ctxInfo?.mentionedJid || [];
    const ts = message.messageTimestamp
      ? new Date(Number(message.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString();

    // Group subject (resolved + cached); DMs use the contact push name.
    const chatName = kind === 'group'
      ? await this.resolveGroupName(chatJid)
      : (message.pushName || null);

    const row = {
      account: this.accountId,
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
    await insertMessage(row).catch((e) =>
      console.error('[wa:%s] insert failed:', this.accountId, e.message));
    await upsertChat({
      account: this.accountId, chat_jid: chatJid, chat_kind: kind, chat_name: row.chat_name,
    }).catch(() => {});

    // Only forward genuinely-new inbound (not our own, not history sync) to Luna.
    if (fromMe || !isNotify) return;

    const mentionedMe =
      this.selfNumber && mentionedJids.some((j) => normalizeNumber(j) === this.selfNumber);
    const isReplyToMe =
      this.selfNumber && ctxInfo?.participant &&
      normalizeNumber(ctxInfo.participant) === this.selfNumber;

    // Show the WhatsApp "typing…" indicator for the whole time Luna is thinking.
    await this.withComposing(chatJid, () =>
      forwardInbound({
        account: this.accountId,
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
      }, { url: this.inboundUrl, secret: this.secret }),
    );
  }

  async handleReaction(entry) {
    const env = parseReaction(entry, { account: this.accountId });
    if (!env) return;
    if (env.chat_kind === 'group') {
      env.chat_name = await this.resolveGroupName(env.chat_jid);
    }
    await forwardInbound(env, { url: this.inboundUrl, secret: this.secret });
  }

  // Baileys logs restriction pushback (463 etc.) without emitting any event —
  // a per-session pino hook is the only place to catch it and trip the breaker.
  _makeLogger() {
    const session = this;
    return pino({
      level: LOG_LEVEL,
      hooks: {
        logMethod(inputArgs, method) {
          if (detectRestrictionSignal(inputArgs)) {
            session.tripBreaker('whatsapp restriction signal in client log');
          }
          return method.apply(this, inputArgs);
        },
      },
    });
  }

  // Optional per-account egress proxy (006 Part E). Sticky residential/mobile
  // proxies keep N accounts from sharing one datacenter IP's fate.
  async _makeAgent() {
    if (!this.proxyUrl) return undefined;
    try {
      if (/^socks/i.test(this.proxyUrl)) {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        return new SocksProxyAgent(this.proxyUrl);
      }
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      return new HttpsProxyAgent(this.proxyUrl);
    } catch (e) {
      console.error('[wa:%s] proxy agent unavailable (%s) — connecting direct',
        this.accountId, e.message);
      return undefined;
    }
  }

  async start() {
    this.stopped = false;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const agent = await this._makeAgent();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: this._makeLogger(),
      printQRInTerminal: false,
      browser: pickBrowser(this.accountId),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: config.keepAliveIntervalMs,
      connectTimeoutMs: config.connectTimeoutMs,
      defaultQueryTimeoutMs: config.defaultQueryTimeoutMs,
      ...(agent ? { agent, fetchAgent: agent } : {}),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      // A stopped session (account deleted / shutdown) must not resurrect
      // status writes — deleteAccount sets the final row state itself.
      if (this.stopped) return;
      const { connection, lastDisconnect, qr } = update;
      this.markActivity();
      if (qr) {
        this.currentQr = qr;
        this._sawQr = true;
        this.status = 'linking';
        await this.setAccountState({ status: 'linking' });
        console.log('[wa:%s] QR ready — scan to link', this.accountId);
      }
      if (connection === 'open') {
        this.status = 'open';
        this.currentQr = null;
        this.selfJid = sock.user?.id || null;
        this.selfNumber = normalizeNumber(this.selfJid);
        const patch = {
          status: 'open',
          self_jid: this.selfJid,
          last_seen: new Date().toISOString(),
        };
        // Open after a QR was shown = a fresh (re)link → start the warm-up
        // probation window (halved caps, doubled gaps).
        if (this._sawQr) {
          this._sawQr = false;
          this.linkedAt = Date.now();
          patch.linked_at = new Date(this.linkedAt).toISOString();
          console.log('[wa:%s] fresh link — warm-up mode for %dh',
            this.accountId, config.warmupHours);
        }
        await this.setAccountState(patch);
        this.outbox?.wake();
        console.log('[wa:%s] connection open as %s', this.accountId, this.selfJid);
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.status = loggedOut ? 'logged_out' : 'disconnected';
        await this.setAccountState({ status: this.status });
        console.log('[wa:%s] connection closed. code=%s loggedOut=%s',
          this.accountId, code, loggedOut);
        // 401/403 is enforcement (device_removed / conflict / forbidden), not a
        // network blip — freeze outbound so we never "retry through" it.
        if (code === 401 || code === 403) {
          this.tripBreaker(`connection closed with code ${code}`);
        }
        if (!loggedOut && !this.stopped) this.scheduleReconnect();
        else if (loggedOut) {
          console.log('[wa:%s] logged out — re-link required', this.accountId);
        }
      }
    });

    // A group rename/metadata change invalidates the cached subject.
    sock.ev.on('groups.update', (updates) => {
      for (const u of updates || []) {
        if (u?.id) this.groupNameCache.delete(u.id);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      this.markActivity();
      const isNotify = type === 'notify';
      for (const message of messages) {
        try {
          await this.handleMessage(message, isNotify);
        } catch (e) {
          console.error('[wa:%s] handleMessage error:', this.accountId, e.message);
        }
      }
    });

    sock.ev.on('messages.reaction', async (reactions) => {
      this.markActivity();
      for (const entry of reactions || []) {
        try {
          await this.handleReaction(entry);
        } catch (e) {
          console.error('[wa:%s] handleReaction error:', this.accountId, e.message);
        }
      }
    });

    this.startWatchdog();
  }

  scheduleReconnect() {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    setTimeout(async () => {
      this.reconnecting = false;
      if (this.stopped) return;
      try {
        console.log('[wa:%s] reconnecting…', this.accountId);
        await this.start();
      } catch (e) {
        console.error('[wa:%s] reconnect failed:', this.accountId, e.message);
        this.scheduleReconnect();
      }
    }, 3000);
  }

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(async () => {
      const idle = Date.now() - this.lastActivityAt;
      await this.setAccountState({ last_seen: new Date().toISOString() });
      // Zombie-socket backstop: looks "open" but no activity for too long.
      if (this.status === 'open' && idle > config.appSilenceBackstopMs) {
        console.log('[wa:%s] watchdog: %dms idle, forcing reconnect', this.accountId, idle);
        try {
          this.sock?.end?.(new Error('watchdog forced reconnect'));
        } catch {}
        this.status = 'disconnected';
        this.scheduleReconnect();
      }
    }, 30000);
  }

  // Stop the session (account deletion or shutdown). logout=true unlinks the
  // number on the phone side too.
  async stop({ logout = false } = {}) {
    this.stopped = true;
    this.outbox?.stop();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.sock) {
      if (logout) {
        try { await this.sock.logout(); } catch {}
      }
      try { this.sock.end?.(new Error('session stopped')); } catch {}
      this.sock = null;
    }
    this.status = 'disabled';
    this.currentQr = null;
  }

  // Warm-up probation halves the daily budget (006).
  effectiveDailyCap() {
    return this.inWarmup() ? Math.max(1, Math.floor(this.dailyCap / 2)) : this.dailyCap;
  }

  // The outbox worker's send hook: one queued row → one real send. Media
  // sources stored as url/base64 in the payload are materialized here, at
  // send time, not at enqueue time.
  async deliverOutboxRow(row) {
    const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (row.kind === 'text') {
      return this.sendText(row.chat_jid, p.text, p.reply_to);
    }
    if (row.kind === 'react') {
      return this.react(row.chat_jid, p.wa_msg_id, p.emoji);
    }
    if (row.kind === 'media') {
      let source;
      if (p.data_base64) {
        source = Buffer.from(p.data_base64, 'base64');
      } else if (/^https?:\/\//i.test(p.url || '')) {
        const r = await fetch(p.url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`fetch media ${r.status}`);
        source = Buffer.from(await r.arrayBuffer());
      } else {
        source = p.url; // local path — Baileys' url loader
      }
      return this.sendMedia(row.chat_jid, p.media_kind || 'image', source, {
        caption: p.caption, mimetype: p.mimetype, fileName: p.file_name,
        replyToWaId: p.reply_to, ptt: p.ptt, gifPlayback: p.gif_playback, ptv: p.ptv,
      });
    }
    throw new Error(`unknown outbox kind: ${row.kind}`);
  }

  // WA_DRY_SEND=1 (dev/test only): accept sends with no linked number — run
  // the real cap+capture path, skip the socket. Lets the dojo suite and local
  // dev exercise the full plugin→gateway loop without linking a real WhatsApp.
  async dryDeliver(chatJid, kind, body, replyToWaId) {
    const allowed = await bumpSendCounter(this.accountId, this.effectiveDailyCap());
    if (!allowed) throw new Error('daily send cap reached');
    const waMsgId = `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await insertMessage({
      account: this.accountId, chat_jid: chatJid, chat_kind: chatKind(chatJid),
      sender_jid: this.selfJid, from_me: true, wa_msg_id: waMsgId,
      reply_to_id: replyToWaId ?? null, ts: new Date().toISOString(),
      kind, body,
    }).catch(() => {});
    return { wa_msg_id: waMsgId, dry: true };
  }

  async sendText(chatJid, text, replyToWaId) {
    if (this.breakerOpen()) {
      throw Object.assign(new Error(`outbound frozen: ${this.breakerReason}`),
        { status: 503, code: 'breaker_open' });
    }
    if (!this.sock || this.status !== 'open') {
      if (process.env.WA_DRY_SEND === '1') return this.dryDeliver(chatJid, 'text', text, replyToWaId);
      throw new Error('WhatsApp socket not connected');
    }
    const allowed = await bumpSendCounter(this.accountId, this.effectiveDailyCap());
    if (!allowed) throw new Error('daily send cap reached');
    // Light jitter to look less bot-like (ban-risk guard).
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    const options = {};
    if (replyToWaId) {
      options.quoted = { key: { remoteJid: chatJid, id: replyToWaId }, message: {} };
    }
    const sent = await this.sock.sendMessage(chatJid, { text }, options);
    return { wa_msg_id: sent?.key?.id || null };
  }

  // Send any media kind (image/video/audio/document/sticker). Reuses the same
  // send-cap + jitter guards as text so ban-risk pacing is identical.
  async sendMedia(chatJid, mediaKind, source, opts = {}) {
    if (this.breakerOpen()) {
      throw Object.assign(new Error(`outbound frozen: ${this.breakerReason}`),
        { status: 503, code: 'breaker_open' });
    }
    if (!this.sock || this.status !== 'open') {
      if (process.env.WA_DRY_SEND === '1') {
        return this.dryDeliver(chatJid, mediaKind, opts.caption || '', opts.replyToWaId);
      }
      throw new Error('WhatsApp socket not connected');
    }
    const allowed = await bumpSendCounter(this.accountId, this.effectiveDailyCap());
    if (!allowed) throw new Error('daily send cap reached');
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));

    const options = {};
    if (opts.replyToWaId) {
      options.quoted = { key: { remoteJid: chatJid, id: opts.replyToWaId }, message: {} };
    }

    const media = toMediaUpload(source);
    const content = buildMediaContent(mediaKind, media, opts);
    const sent = await this.sock.sendMessage(chatJid, content, options);
    return { wa_msg_id: sent?.key?.id || null };
  }

  async react(chatJid, waMsgId, emoji) {
    if (!this.sock || this.status !== 'open') {
      if (process.env.WA_DRY_SEND === '1') return { ok: true, dry: true };
      throw new Error('WhatsApp socket not connected');
    }
    await this.sock.sendMessage(chatJid, {
      react: { text: emoji, key: { remoteJid: chatJid, id: waMsgId } },
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // target resolution + group management
  // -------------------------------------------------------------------------

  _isLive() {
    return !!this.sock && this.status === 'open';
  }

  _requireSock() {
    if (!this._isLive()) throw new Error('WhatsApp socket not connected');
  }

  // Resolve a loose target (JID | phone number in any human format) to a
  // canonical sendable JID. Numbers are verified with onWhatsApp so a typo'd
  // or unregistered number fails loudly here (404) instead of vanishing
  // inside Baileys.
  async resolveJid(input) {
    const t = normalizeTarget(input);
    if (!t) {
      throw Object.assign(
        new Error(`invalid target: ${JSON.stringify(String(input ?? ''))} — pass a JID, a phone number, or a group JID (…@g.us)`),
        { status: 400 },
      );
    }
    if (t.jid) return t.jid;
    const fallback = `${t.number}@s.whatsapp.net`;
    if (!this._isLive()) {
      if (process.env.WA_DRY_SEND === '1') return fallback;
      throw new Error('WhatsApp socket not connected');
    }
    try {
      const res = await this.sock.onWhatsApp(t.number);
      const hit = (res || []).find((r) => r?.jid && r?.exists !== false);
      if (!hit) {
        throw Object.assign(
          new Error(`${t.number} is not on WhatsApp`), { status: 404, code: 'not_on_whatsapp' },
        );
      }
      return hit.jid;
    } catch (e) {
      if (e.status) throw e;
      // onWhatsApp is best-effort — a transient query failure must not block
      // a well-formed number.
      console.error('[wa:%s] onWhatsApp lookup failed:', this.accountId, e.message);
      return fallback;
    }
  }

  async listGroups() {
    if (!this._isLive()) {
      if (process.env.WA_DRY_SEND === '1') return [];
      throw new Error('WhatsApp socket not connected');
    }
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all || {}).map((g) => ({
      jid: g.id,
      subject: g.subject || null,
      participants_count: (g.participants || []).length,
      owner: g.owner || null,
      announce: !!g.announce,
    }));
  }

  async groupInfo(groupJid) {
    if (!this._isLive() && process.env.WA_DRY_SEND === '1') {
      return shapeGroupMeta({ id: groupJid, subject: 'dry group' }, this.selfNumber);
    }
    this._requireSock();
    const meta = await this.sock.groupMetadata(groupJid);
    return shapeGroupMeta(meta, this.selfNumber);
  }

  async groupRename(groupJid, subject) {
    if (!this._isLive() && process.env.WA_DRY_SEND === '1') {
      return { ok: true, dry: true };
    }
    this._requireSock();
    await this.sock.groupUpdateSubject(groupJid, subject);
    this.groupNameCache.delete(groupJid); // subject changed — bust the cache now
    return { ok: true };
  }

  // action: add | remove | promote | demote. Targets may be numbers or JIDs.
  async groupParticipants(groupJid, action, targets) {
    if (!GROUP_PARTICIPANT_ACTIONS.includes(action)) {
      throw Object.assign(
        new Error(`action must be one of ${GROUP_PARTICIPANT_ACTIONS.join('|')}`), { status: 400 },
      );
    }
    const jids = [];
    for (const t of targets) jids.push(await this.resolveJid(t));
    if (!this._isLive() && process.env.WA_DRY_SEND === '1') {
      return { results: jids.map((jid) => ({ jid, status: '200' })), dry: true };
    }
    this._requireSock();
    const res = await this.sock.groupParticipantsUpdate(groupJid, jids, action);
    // Baileys returns per-participant status strings ('200' ok, '403' not
    // allowed, '408' recently left, …) — surface them instead of flattening.
    return { results: (res || []).map((r) => ({ jid: r.jid, status: String(r.status ?? '') })) };
  }

  async groupCreate(subject, targets) {
    const jids = [];
    for (const t of targets || []) jids.push(await this.resolveJid(t));
    if (!this._isLive() && process.env.WA_DRY_SEND === '1') {
      return shapeGroupMeta(
        { id: `DRY-${subject}@g.us`, subject, participants: jids.map((j) => ({ id: j })) },
        this.selfNumber,
      );
    }
    this._requireSock();
    const meta = await this.sock.groupCreate(subject, jids);
    return shapeGroupMeta(meta, this.selfNumber);
  }

  async groupLeave(groupJid) {
    if (!this._isLive() && process.env.WA_DRY_SEND === '1') {
      return { ok: true, dry: true };
    }
    this._requireSock();
    await this.sock.groupLeave(groupJid);
    this.groupNameCache.delete(groupJid);
    return { ok: true };
  }

  async groupInvite(groupJid) {
    if (!this._isLive() && process.env.WA_DRY_SEND === '1') {
      return { code: 'DRYINVITE', url: 'https://chat.whatsapp.com/DRYINVITE', dry: true };
    }
    this._requireSock();
    const code = await this.sock.groupInviteCode(groupJid);
    return { code, url: `https://chat.whatsapp.com/${code}` };
  }
}
