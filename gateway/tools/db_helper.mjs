// DB helper for the dojo conversation tests. Lives under gateway/ so `pg`
// resolves. Two actions:
//   fetch --chat <jid> --since <iso>   -> prints JSON of messages since <iso>
//   plant --chat <jid> --kind <k> --name <n> --text <t>  -> inserts a USER
//       message into the plugin store (whatsapp_plugin_messages) so cross-chat
//       recall can be tested without delivering to a real chat.
//
// Run with:  node --env-file=../.env tools/db_helper.mjs <action> ...
import pg from 'pg';
import crypto from 'node:crypto';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const action = process.argv[2];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  if (action === 'watermark') {
    // Latest from_me reply ts for a chat, so the runner can fetch only rows
    // newer than this after it sends the next message.
    const chat = arg('chat');
    // Cast to text so full microsecond precision survives the JSON round-trip
    // (a JS Date would truncate to milliseconds and let the prior reply leak in).
    const r = await client.query(
      `SELECT coalesce(max(ts), '1970-01-01T00:00:00+00:00'::timestamptz)::text AS wm
         FROM whatsapp_plugin_messages
        WHERE chat_jid = $1 AND from_me = true`,
      [chat],
    );
    console.log(JSON.stringify({ wm: r.rows[0].wm }));
  } else if (action === 'fetch') {
    // Luna's reply is recorded by the plugin into whatsapp_plugin_messages with
    // from_me=true (one row for the text, one per media item). Read only rows
    // strictly newer than the watermark taken before we sent.
    const chat = arg('chat');
    const since = arg('since');
    const r = await client.query(
      `SELECT ts, from_me, kind, reply_to_id, coalesce(body,'') AS body
         FROM whatsapp_plugin_messages
        WHERE chat_jid = $1 AND from_me = true AND ts > $2::timestamptz
        ORDER BY ts ASC`,
      [chat, since],
    );
    console.log(JSON.stringify(r.rows));
  } else if (action === 'plant') {
    // Insert a USER-side message directly into the plugin's context store.
    await client.query(
      `INSERT INTO whatsapp_plugin_messages
         (id, chat_jid, chat_kind, chat_name, sender_jid, sender_name,
          from_me, wa_msg_id, ts, kind, body, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7, now(), 'text', $8, now())
       ON CONFLICT (wa_msg_id) DO NOTHING`,
      [
        crypto.randomUUID(), arg('chat'), arg('kind', 'group'),
        arg('name', 'Someone'), arg('chat'), arg('name', 'Someone'),
        'PLANT-' + crypto.randomUUID().slice(0, 12), arg('text', ''),
      ],
    );
    console.log(JSON.stringify({ ok: true }));
  } else if (action === 'plant-out') {
    // Insert a LUNA-side (from_me) message with an explicit wa_msg_id, so a
    // reaction scenario can react to a known message Luna "sent".
    const waId = arg('wa_msg_id', 'OUT-' + crypto.randomUUID().slice(0, 12));
    await client.query(
      `INSERT INTO whatsapp_plugin_messages
         (id, chat_jid, chat_kind, chat_name, sender_jid, sender_name,
          from_me, wa_msg_id, ts, kind, body, created_at)
       VALUES ($1,$2,$3,$4,null,'Luna',true,$5, now(), 'text', $6, now())
       ON CONFLICT (wa_msg_id) DO NOTHING`,
      [
        crypto.randomUUID(), arg('chat'), arg('kind', 'dm'),
        arg('name', null), waId, arg('text', ''),
      ],
    );
    console.log(JSON.stringify({ ok: true, wa_msg_id: waId }));
  } else {
    console.error('unknown action:', action);
    process.exit(2);
  }
} finally {
  await client.end();
}
