// Postgres access + schema bootstrap. The append-only whatsapp_messages table is
// the source of truth; 100% of inbound and outbound are written here BEFORE any
// agent decision, so a Luna restart replays from the DB and never loses a message.
//
// Since 003 (multi-Luna): whatsapp_accounts is the routing registry — one row per
// account = WhatsApp number = Luna instance, carrying that account's HMAC secret,
// inbound URL, link status, and daily send budget. whatsapp_state (the old
// singleton) is deprecated: migrated into whatsapp_accounts('default') on boot,
// then never read or written again.

import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Render managed Postgres requires SSL; local usually doesn't.
  ssl: config.databaseUrl.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account      text NOT NULL,
  chat_jid     text NOT NULL,
  chat_kind    text NOT NULL,
  chat_name    text,
  sender_jid   text,
  sender_name  text,
  from_me      boolean NOT NULL DEFAULT false,
  wa_msg_id    text UNIQUE,
  reply_to_id  text,
  ts           timestamptz NOT NULL,
  kind         text NOT NULL DEFAULT 'text',
  body         text,
  media_path   text,
  raw          jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_ts ON whatsapp_messages (ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_chat_ts ON whatsapp_messages (chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_account_ts ON whatsapp_messages (account, ts DESC);

CREATE TABLE IF NOT EXISTS whatsapp_chats (
  chat_jid     text NOT NULL,
  chat_kind    text NOT NULL,
  chat_name    text,
  policy       jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Deprecated (pre-003 singleton); kept so old rows survive a rollback.
CREATE TABLE IF NOT EXISTS whatsapp_state (
  id           int PRIMARY KEY DEFAULT 1,
  account      text,
  status       text,
  self_jid     text,
  last_seen    timestamptz,
  sent_today   int NOT NULL DEFAULT 0,
  sent_day     date,
  watchdog     jsonb,
  CONSTRAINT singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  account_id   text PRIMARY KEY,
  secret       text NOT NULL,
  inbound_url  text,
  gateway_id   text NOT NULL DEFAULT 'gw-1',
  status       text NOT NULL DEFAULT 'created',
  self_jid     text,
  last_seen    timestamptz,
  sent_today   int NOT NULL DEFAULT 0,
  sent_day     date,
  daily_cap    int,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 006: breaker/warm-up state + optional per-account egress proxy.
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS breaker_until  timestamptz;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS breaker_reason text;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS linked_at      timestamptz;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS proxy_url      text;

-- 008: per-account ElevenLabs voice. Tenant keys pushed by luna-service; the
-- platform env key stays the fallback so existing accounts keep working.
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS eleven_key      text;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS eleven_voice_id text;

-- 006: persistent outbound queue. Every send is a row here first; a per-account
-- worker drains serially with class-based pacing, so a burst is impossible no
-- matter what callers do. Survives restarts/deploys by construction.
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  text NOT NULL,
  chat_jid    text NOT NULL,
  kind        text NOT NULL,              -- text | media | react
  payload     jsonb NOT NULL,
  class       text NOT NULL,              -- conversational | warm | cold
  status      text NOT NULL DEFAULT 'queued', -- queued|sending|sent|failed|canceled|held
  not_before  timestamptz NOT NULL DEFAULT now(),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  wa_msg_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_drain ON whatsapp_outbox (account_id, status, not_before, created_at);
`;

export async function initSchema() {
  await pool.query(SCHEMA);
  await migrateChatsPk();
  await seedDefaultAccount();
}

// Pre-003 whatsapp_chats had PK (chat_jid). Multi-account needs (account,
// chat_jid) — the same group can be visible to two different numbers.
async function migrateChatsPk() {
  await pool.query(
    `ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'default'`,
  );
  const pk = await pool.query(`
    SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = 'whatsapp_chats'::regclass AND i.indisprimary`);
  const cols = pk.rows.map((r) => r.attname).sort();
  if (cols.join(',') !== 'account,chat_jid') {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_chats_pkey') THEN
          ALTER TABLE whatsapp_chats DROP CONSTRAINT whatsapp_chats_pkey;
        END IF;
      END $$`);
    await pool.query(`ALTER TABLE whatsapp_chats ADD PRIMARY KEY (account, chat_jid)`);
  }
}

// Zero-downtime migration: the pre-003 deployment is env-configured. If the
// registry has no `default` row and the legacy secret env is set, materialize
// the account from env + the old whatsapp_state row. Idempotent.
async function seedDefaultAccount() {
  if (!config.sharedSecret) return;
  const existing = await pool.query(
    `SELECT 1 FROM whatsapp_accounts WHERE account_id = $1`,
    [config.account],
  );
  if (existing.rows.length) return;
  const st = (await pool.query(`SELECT * FROM whatsapp_state WHERE id = 1`)).rows[0];
  await pool.query(
    `INSERT INTO whatsapp_accounts
       (account_id, secret, inbound_url, gateway_id, status, self_jid,
        last_seen, sent_today, sent_day)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id) DO NOTHING`,
    [
      config.account, config.sharedSecret, config.lunaInboundUrl || null,
      config.gatewayId, st?.status ?? 'created', st?.self_jid ?? null,
      st?.last_seen ?? null, st?.sent_today ?? 0, st?.sent_day ?? null,
    ],
  );
  console.log(`[db] seeded account '${config.account}' from legacy env`);
}

// ---------------------------------------------------------------------------
// accounts registry
// ---------------------------------------------------------------------------

export async function listAccounts({ includeDisabled = false } = {}) {
  const q = includeDisabled
    ? `SELECT * FROM whatsapp_accounts WHERE gateway_id = $1 ORDER BY created_at`
    : `SELECT * FROM whatsapp_accounts WHERE gateway_id = $1 AND enabled ORDER BY created_at`;
  return (await pool.query(q, [config.gatewayId])).rows;
}

export async function getAccount(accountId) {
  const r = await pool.query(
    `SELECT * FROM whatsapp_accounts WHERE account_id = $1`,
    [accountId],
  );
  return r.rows[0] ?? null;
}

export async function insertAccount({ account_id, secret, inbound_url, daily_cap }) {
  const r = await pool.query(
    `INSERT INTO whatsapp_accounts (account_id, secret, inbound_url, gateway_id, daily_cap)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [account_id, secret, inbound_url ?? null, config.gatewayId, daily_cap ?? null],
  );
  return r.rows[0];
}

// Patch arbitrary registry columns (secret rotation, inbound_url move, state
// writes from the session). Only whitelisted keys to keep SQL injection out.
const ACCOUNT_COLS = new Set([
  'secret', 'inbound_url', 'status', 'self_jid', 'last_seen',
  'sent_today', 'sent_day', 'daily_cap', 'enabled',
  'breaker_until', 'breaker_reason', 'linked_at', 'proxy_url',
  'eleven_key', 'eleven_voice_id',
]);

export async function updateAccount(accountId, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!ACCOUNT_COLS.has(k)) throw new Error(`bad account column: ${k}`);
    fields.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (!fields.length) return null;
  vals.push(accountId);
  const r = await pool.query(
    `UPDATE whatsapp_accounts SET ${fields.join(', ')}, updated_at = now()
      WHERE account_id = $${i} RETURNING *`,
    vals,
  );
  return r.rows[0] ?? null;
}

// Per-account daily send counter with automatic day rollover. Returns false
// when the cap is hit. cap comes from the row's daily_cap or the global default.
export async function bumpSendCounter(accountId, cap) {
  const today = new Date().toISOString().slice(0, 10);
  const acc = await getAccount(accountId);
  let sent = acc?.sent_today ?? 0;
  const day = acc?.sent_day ? new Date(acc.sent_day).toISOString().slice(0, 10) : null;
  if (day !== today) sent = 0;
  if (sent >= cap) return false;
  await updateAccount(accountId, { sent_today: sent + 1, sent_day: today });
  return true;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

export async function insertMessage(m) {
  // Idempotent on wa_msg_id so replays / dupes never double-write.
  const q = `
    INSERT INTO whatsapp_messages
      (account, chat_jid, chat_kind, chat_name, sender_jid, sender_name,
       from_me, wa_msg_id, reply_to_id, ts, kind, body, media_path, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (wa_msg_id) DO NOTHING
    RETURNING id`;
  const vals = [
    m.account, m.chat_jid, m.chat_kind, m.chat_name ?? null,
    m.sender_jid ?? null, m.sender_name ?? null, !!m.from_me,
    m.wa_msg_id ?? null, m.reply_to_id ?? null, m.ts,
    m.kind ?? 'text', m.body ?? null, m.media_path ?? null,
    m.raw ? JSON.stringify(m.raw) : null,
  ];
  const res = await pool.query(q, vals);
  return res.rows[0]?.id ?? null;
}

export async function upsertChat(c) {
  await pool.query(
    `INSERT INTO whatsapp_chats (account, chat_jid, chat_kind, chat_name, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (account, chat_jid) DO UPDATE SET chat_name = EXCLUDED.chat_name, updated_at = now()`,
    [c.account ?? 'default', c.chat_jid, c.chat_kind, c.chat_name ?? null],
  );
}

// ---------------------------------------------------------------------------
// outbox (006 anti-ban send discipline)
// ---------------------------------------------------------------------------

// pgOutboxStore implements the store interface OutboxWorker consumes (see
// outbox.js for the in-memory test double). All queries are account-scoped.
export const pgOutboxStore = {
  async enqueue({ account_id, chat_jid, kind, payload, cls, not_before }) {
    const r = await pool.query(
      `INSERT INTO whatsapp_outbox (account_id, chat_jid, kind, payload, class, not_before)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6, now())) RETURNING *`,
      [account_id, chat_jid, kind, JSON.stringify(payload), cls, not_before ?? null],
    );
    return r.rows[0];
  },

  // FIFO head of the queue (retries keep their slot; the worker sleeps until
  // the head's not_before when it is in the future).
  async nextQueued(accountId) {
    const r = await pool.query(
      `SELECT * FROM whatsapp_outbox
        WHERE account_id = $1 AND status = 'queued'
        ORDER BY not_before, created_at LIMIT 1`,
      [accountId],
    );
    return r.rows[0] ?? null;
  },

  async mark(id, patch) {
    const COLS = new Set(['status', 'attempts', 'last_error', 'wa_msg_id', 'sent_at', 'not_before']);
    const fields = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      if (!COLS.has(k)) throw new Error(`bad outbox column: ${k}`);
      fields.push(`${k} = $${i++}`);
      vals.push(v);
    }
    vals.push(id);
    // Claiming a row ('sending') only succeeds from 'queued' — this is what
    // makes /outbox/cancel race-free against the drain loop.
    const guard = patch.status === 'sending' ? ` AND status = 'queued'` : '';
    const r = await pool.query(
      `UPDATE whatsapp_outbox SET ${fields.join(', ')} WHERE id = $${i}${guard} RETURNING *`,
      vals,
    );
    return r.rows[0] ?? null;
  },

  async get(id, accountId) {
    const r = await pool.query(
      `SELECT * FROM whatsapp_outbox WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    return r.rows[0] ?? null;
  },

  async pending(accountId) {
    const r = await pool.query(
      `SELECT * FROM whatsapp_outbox
        WHERE account_id = $1 AND status IN ('queued','sending','held')
        ORDER BY not_before, created_at`,
      [accountId],
    );
    return r.rows;
  },

  async cancel(id, accountId) {
    const r = await pool.query(
      `UPDATE whatsapp_outbox SET status = 'canceled'
        WHERE id = $1 AND account_id = $2 AND status = 'queued' RETURNING *`,
      [id, accountId],
    );
    return r.rows[0] ?? null;
  },

  // Breaker trip: park everything; nothing auto-fires when the breaker clears.
  async holdQueued(accountId) {
    const r = await pool.query(
      `UPDATE whatsapp_outbox SET status = 'held'
        WHERE account_id = $1 AND status = 'queued' RETURNING id`,
      [accountId],
    );
    return r.rowCount;
  },

  async releaseHeld(accountId) {
    const r = await pool.query(
      `UPDATE whatsapp_outbox SET status = 'queued', not_before = now()
        WHERE account_id = $1 AND status = 'held' RETURNING id`,
      [accountId],
    );
    return r.rowCount;
  },

  // Crash recovery: rows stuck in 'sending' from a previous process go back to
  // queued (at-least-once; WhatsApp has no idempotent send to lean on).
  async recoverSending(accountId) {
    const r = await pool.query(
      `UPDATE whatsapp_outbox SET status = 'queued'
        WHERE account_id = $1 AND status = 'sending' RETURNING id`,
      [accountId],
    );
    return r.rowCount;
  },

  // Cold budget accounting: everything admitted today (queued/sending/sent)
  // counts, so canceling and re-enqueueing can't launder budget.
  async coldCounts(accountId) {
    const r = await pool.query(
      `SELECT
         count(*) FILTER (WHERE created_at >= date_trunc('day', now()))  AS today,
         count(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS hour
       FROM whatsapp_outbox
       WHERE account_id = $1 AND class = 'cold'
         AND status IN ('queued','sending','sent')`,
      [accountId],
    );
    return { today: Number(r.rows[0].today), hour: Number(r.rows[0].hour) };
  },

  // Recipient classification input: when did this chat last write to us?
  async lastInboundAt(accountId, chatJid) {
    const r = await pool.query(
      `SELECT max(ts) AS last FROM whatsapp_messages
        WHERE account = $1 AND chat_jid = $2 AND NOT from_me`,
      [accountId, chatJid],
    );
    return r.rows[0]?.last ?? null;
  },

  async queueDepth(accountId) {
    const r = await pool.query(
      `SELECT count(*) AS n FROM whatsapp_outbox
        WHERE account_id = $1 AND status IN ('queued','sending')`,
      [accountId],
    );
    return Number(r.rows[0].n);
  },
};

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

// Read-only aggregates for the /stats monitoring endpoint. All served by the
// ts indexes; cheap at this table's scale.
export async function getMessageStats() {
  const windows = await pool.query(`
    SELECT
      count(*)                                                          AS total_messages,
      count(DISTINCT chat_jid)                                          AS total_chats,
      count(DISTINCT sender_jid) FILTER (WHERE NOT from_me)             AS total_users,
      max(ts)                                                           AS last_message_at,
      count(*)                   FILTER (WHERE ts > now() - interval '1 hour' AND NOT from_me) AS in_1h,
      count(*)                   FILTER (WHERE ts > now() - interval '1 hour' AND from_me)     AS out_1h,
      count(DISTINCT chat_jid)   FILTER (WHERE ts > now() - interval '1 hour')                 AS chats_1h,
      count(DISTINCT sender_jid) FILTER (WHERE ts > now() - interval '1 hour' AND NOT from_me) AS users_1h,
      count(*)                   FILTER (WHERE ts > now() - interval '24 hours' AND NOT from_me) AS in_24h,
      count(*)                   FILTER (WHERE ts > now() - interval '24 hours' AND from_me)     AS out_24h,
      count(DISTINCT chat_jid)   FILTER (WHERE ts > now() - interval '24 hours')                 AS chats_24h,
      count(DISTINCT sender_jid) FILTER (WHERE ts > now() - interval '24 hours' AND NOT from_me) AS users_24h
    FROM whatsapp_messages`);
  const hourly = await pool.query(`
    SELECT date_trunc('hour', ts) AS hour,
           count(*) FILTER (WHERE NOT from_me) AS inbound,
           count(*) FILTER (WHERE from_me)     AS outbound
    FROM whatsapp_messages
    WHERE ts > now() - interval '24 hours'
    GROUP BY 1 ORDER BY 1`);
  const media = await pool.query(`
    SELECT kind, count(*) AS n
    FROM whatsapp_messages
    WHERE ts > now() - interval '24 hours' AND kind <> 'text'
    GROUP BY kind ORDER BY n DESC`);
  return { windows: windows.rows[0], hourly: hourly.rows, media: media.rows };
}

// 24h in/out per account, for the /stats accounts[] breakdown.
export async function getAccountMessageStats() {
  const r = await pool.query(`
    SELECT account,
           count(*) FILTER (WHERE NOT from_me) AS in_24h,
           count(*) FILTER (WHERE from_me)     AS out_24h
    FROM whatsapp_messages
    WHERE ts > now() - interval '24 hours'
    GROUP BY account`);
  return Object.fromEntries(r.rows.map((row) => [row.account, row]));
}
