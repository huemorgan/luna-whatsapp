// Gateway unit tests (node --test). Pure logic only — no socket, no Postgres.
// Dummy env is set before importing modules that read config at load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WA_SHARED_SECRET ||= 'unit-test-secret';
process.env.GATEWAY_ADMIN_KEY ||= 'unit-test-admin';
process.env.DATABASE_URL ||= 'postgres://localhost/none';

const { sign, verify } = await import('../src/hmac.js');
const { buildMediaContent, toMediaUpload, withComposing, parseReaction } =
  await import('../src/wa.js');

test('hmac sign/verify roundtrip', () => {
  const body = JSON.stringify({ chat_jid: 'x@s.whatsapp.net', text: 'hi' });
  const { timestamp, signature } = sign(process.env.WA_SHARED_SECRET, body);
  assert.equal(verify(process.env.WA_SHARED_SECRET, body, timestamp, signature), true);
});

test('hmac rejects a tampered body', () => {
  const body = JSON.stringify({ text: 'hi' });
  const { timestamp, signature } = sign('s', body);
  assert.equal(verify('s', JSON.stringify({ text: 'HI' }), timestamp, signature), false);
});

test('hmac rejects a wrong secret', () => {
  const body = 'payload';
  const { timestamp, signature } = sign('right', body);
  assert.equal(verify('wrong', body, timestamp, signature), false);
});

test('toMediaUpload: buffer passes through', () => {
  const buf = Buffer.from('abc');
  assert.equal(toMediaUpload(buf), buf);
});

test('toMediaUpload: string becomes { url }', () => {
  assert.deepEqual(toMediaUpload('https://a/x.png'), { url: 'https://a/x.png' });
});

test('toMediaUpload: rejects unsupported source', () => {
  assert.throws(() => toMediaUpload(123));
});

test('buildMediaContent: image with caption', () => {
  const c = buildMediaContent('image', Buffer.from('x'), { caption: 'hi' });
  assert.ok(c.image);
  assert.equal(c.caption, 'hi');
});

test('buildMediaContent: video gifPlayback flag', () => {
  const c = buildMediaContent('video', { url: 'u' }, { gifPlayback: true });
  assert.equal(c.gifPlayback, true);
  assert.equal(c.ptv, false);
});

test('buildMediaContent: audio defaults to voice note opus', () => {
  const c = buildMediaContent('audio', Buffer.from('x'));
  assert.equal(c.ptt, true);
  assert.match(c.mimetype, /opus/);
});

test('buildMediaContent: document requires sane defaults', () => {
  const c = buildMediaContent('document', { url: 'u' }, { fileName: 'r.pdf', mimetype: 'application/pdf' });
  assert.equal(c.fileName, 'r.pdf');
  assert.equal(c.mimetype, 'application/pdf');
});

test('buildMediaContent: unsupported kind throws', () => {
  assert.throws(() => buildMediaContent('hologram', Buffer.from('x')));
});

// withComposing wraps the forward work in a typing indicator. With no live
// socket, presence is a safe no-op; the contract we guard is that the wrapper
// never swallows or corrupts the wrapped work.
test('withComposing: returns the wrapped fn result', async () => {
  const out = await withComposing('x@s.whatsapp.net', async () => 42);
  assert.equal(out, 42);
});

test('withComposing: propagates errors from the wrapped fn (interval cleared)', async () => {
  await assert.rejects(
    withComposing('x@s.whatsapp.net', async () => { throw new Error('turn failed'); }),
    /turn failed/,
  );
  // If the keepalive interval were left running, the test process would hang;
  // node --test completing is itself the assertion that it was cleared.
});

// --- reactions: only forward a like on OUR message ---

const dmReaction = (over = {}) => ({
  key: { remoteJid: '12345@s.whatsapp.net', fromMe: true, id: 'MSG1', ...over.key },
  reaction: {
    text: '👍',
    key: { remoteJid: '12345@s.whatsapp.net', fromMe: false, id: 'RID1' },
    ...over.reaction,
  },
});

test('parseReaction: forwards a like on our own DM message', () => {
  const env = parseReaction(dmReaction(), { account: 'default' });
  assert.ok(env);
  assert.equal(env.kind, 'reaction');
  assert.equal(env.reaction_emoji, '👍');
  assert.equal(env.reaction_target_id, 'MSG1');
  assert.equal(env.reaction_target_from_me, true);
  assert.equal(env.is_reply_to_me, true);
  assert.equal(env.chat_jid, '12345@s.whatsapp.net');
  assert.equal(env.wa_msg_id, 'RID1');
});

test('parseReaction: ignores a reaction to someone else\'s message', () => {
  const entry = dmReaction({ key: { fromMe: false } });
  assert.equal(parseReaction(entry), null);
});

test('parseReaction: ignores our own reaction', () => {
  const entry = dmReaction({ reaction: { key: { fromMe: true } } });
  assert.equal(parseReaction(entry), null);
});

test('parseReaction: ignores a reaction removal (empty emoji)', () => {
  const entry = dmReaction({ reaction: { text: '' } });
  assert.equal(parseReaction(entry), null);
});

test('parseReaction: group reaction uses the reactor participant as sender', () => {
  const entry = {
    key: { remoteJid: '120@g.us', fromMe: true, id: 'GMSG' },
    reaction: { text: '❤️', key: { fromMe: false, participant: '99@s.whatsapp.net', id: 'GRID' } },
  };
  const env = parseReaction(entry, { account: 'default' });
  assert.equal(env.chat_kind, 'group');
  assert.equal(env.sender_jid, '99@s.whatsapp.net');
  assert.equal(env.reaction_emoji, '❤️');
});

test('parseReaction: synthesizes an id when the reaction key has none', () => {
  const entry = dmReaction({ reaction: { key: { fromMe: false } } });
  const env = parseReaction(entry);
  assert.equal(env.wa_msg_id, 'react-MSG1-👍');
});

// /stats payload assembly — pure shaping, no Postgres. Guards the contract the
// luna-service monitoring page reads.
const { buildStatsPayload } = await import('../src/stats.js');

const CONN = {
  status: 'open', connected: true, self_jid: '1@s.whatsapp.net',
  has_qr: false, last_activity_at: '2026-01-01T00:00:00.000Z',
};

test('buildStatsPayload: full happy path shapes windows and totals', () => {
  const p = buildStatsPayload({
    conn: CONN,
    state: { sent_today: 7 },
    cap: 300,
    version: '0.1.0',
    dbLatencyMs: 12,
    stats: {
      windows: {
        total_messages: '120', total_chats: '9', total_users: '5',
        last_message_at: new Date('2026-01-01T00:00:00Z'),
        in_1h: '3', out_1h: '2', chats_1h: '2', users_1h: '1',
        in_24h: '80', out_24h: '40', chats_24h: '8', users_24h: '5',
      },
      hourly: [{ hour: new Date('2026-01-01T00:00:00Z'), inbound: '3', outbound: '1' }],
      media: [{ kind: 'image', n: '4' }, { kind: 'audio', n: '1' }],
    },
  });
  assert.equal(p.connected, true);
  assert.equal(p.db.ok, true);
  assert.equal(p.db.latency_ms, 12);
  assert.equal(p.sent_today, 7);
  assert.equal(p.send_daily_cap, 300);
  assert.deepEqual(p.totals, { messages: 120, chats: 9, users: 5 });
  assert.deepEqual(p.last_hour, {
    messages_in: 3, messages_out: 2, active_chats: 2, active_users: 1,
  });
  assert.deepEqual(p.last_24h, {
    messages_in: 80, messages_out: 40, active_chats: 8, active_users: 5,
  });
  assert.deepEqual(p.media_24h, { image: 4, audio: 1 });
  assert.deepEqual(p.hourly, [{ hour: '2026-01-01T00:00:00.000Z', in: 3, out: 1 }]);
  assert.equal(p.last_message_at, '2026-01-01T00:00:00.000Z');
  assert.equal(typeof p.uptime_s, 'number');
  assert.equal(typeof p.rss_mb, 'number');
});

test('buildStatsPayload: DB down still reports socket state', () => {
  const p = buildStatsPayload({
    conn: CONN, state: null, stats: null, cap: 300,
    version: '0.1.0', dbError: 'connection refused',
  });
  assert.equal(p.connected, true);
  assert.equal(p.status, 'open');
  assert.equal(p.db.ok, false);
  assert.equal(p.db.error, 'connection refused');
  assert.equal(p.sent_today, 0);
  assert.equal(p.totals, undefined);
});

test('buildStatsPayload: empty table yields zeroed counters', () => {
  const p = buildStatsPayload({
    conn: { ...CONN, status: 'connecting', connected: false },
    state: { sent_today: 0 }, cap: 300, version: '0.1.0', dbLatencyMs: 3,
    stats: { windows: {}, hourly: [], media: [] },
  });
  assert.equal(p.connected, false);
  assert.deepEqual(p.totals, { messages: 0, chats: 0, users: 0 });
  assert.deepEqual(p.media_24h, {});
  assert.deepEqual(p.hourly, []);
  assert.equal(p.last_message_at, null);
});
