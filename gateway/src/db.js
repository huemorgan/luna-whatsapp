// Postgres access + schema bootstrap. The append-only whatsapp_messages table is
// the source of truth; 100% of inbound and outbound are written here BEFORE any
// agent decision, so a Luna restart replays from the DB and never loses a message.

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

CREATE TABLE IF NOT EXISTS whatsapp_chats (
  chat_jid     text PRIMARY KEY,
  chat_kind    text NOT NULL,
  chat_name    text,
  policy       jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

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
INSERT INTO whatsapp_state (id, status) VALUES (1, 'starting')
  ON CONFLICT (id) DO NOTHING;
`;

export async function initSchema() {
  await pool.query(SCHEMA);
}

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
    `INSERT INTO whatsapp_chats (chat_jid, chat_kind, chat_name, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (chat_jid) DO UPDATE SET chat_name = EXCLUDED.chat_name, updated_at = now()`,
    [c.chat_jid, c.chat_kind, c.chat_name ?? null],
  );
}

export async function setState(patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (!fields.length) return;
  await pool.query(`UPDATE whatsapp_state SET ${fields.join(', ')} WHERE id = 1`, vals);
}

export async function getState() {
  const res = await pool.query('SELECT * FROM whatsapp_state WHERE id = 1');
  return res.rows[0] ?? null;
}

// Daily send counter with automatic rollover. Returns false if the cap is hit.
export async function bumpSendCounter(cap) {
  const today = new Date().toISOString().slice(0, 10);
  const st = await getState();
  let sent = st?.sent_today ?? 0;
  const day = st?.sent_day ? new Date(st.sent_day).toISOString().slice(0, 10) : null;
  if (day !== today) sent = 0;
  if (sent >= cap) return false;
  await setState({ sent_today: sent + 1, sent_day: today });
  return true;
}
