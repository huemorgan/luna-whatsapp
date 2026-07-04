// Gateway unit tests (node --test). Pure logic only — no socket, no Postgres.
// Dummy env is set before importing modules that read config at load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WA_SHARED_SECRET ||= 'unit-test-secret';
process.env.GATEWAY_ADMIN_KEY ||= 'unit-test-admin';
process.env.DATABASE_URL ||= 'postgres://localhost/none';

const { sign, verify } = await import('../src/hmac.js');
const { buildMediaContent, toMediaUpload, parseReaction, Session } =
  await import('../src/session.js');
const { resolveAccountId, validAccountId } = await import('../src/accounts.js');

// A Session with no socket: presence is a safe no-op, which is exactly what
// the withComposing contract tests need.
const withComposing = (jid, fn) =>
  new Session({ account_id: 'test', secret: 's' }).withComposing(jid, fn);

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

// ---------------------------------------------------------------------------
// 003 multi-Luna: account id validation + request→account resolution
// ---------------------------------------------------------------------------

test('validAccountId: accepts slugs, rejects traversal and junk', () => {
  for (const ok of ['default', 'acme-agent', 'a', 'x.y_z-9']) {
    assert.equal(validAccountId(ok), true, ok);
  }
  for (const bad of ['', 'UPPER', '-lead', '../etc', 'a/b', 'a'.repeat(65), null, 42]) {
    assert.equal(validAccountId(bad), false, String(bad));
  }
});

function signedReq(secret, body) {
  const { timestamp, signature } = sign(secret, body);
  return { rawBody: body, ts: timestamp, sig: signature };
}

const CANDIDATES = [
  { id: 'alice', secret: 'alice-secret' },
  { id: 'bob', secret: 'bob-secret' },
];
const LEGACY = { secret: 'legacy-secret', accountId: 'default' };

test('resolveAccountId: scan finds the right account by secret alone', () => {
  const body = JSON.stringify({ chat_jid: 'x', text: 'hi' });
  const r = signedReq('bob-secret', body);
  assert.equal(
    resolveAccountId({ headerAccount: null, rawBody: body, ts: r.ts, sig: r.sig },
      CANDIDATES, LEGACY),
    'bob',
  );
});

test('resolveAccountId: explicit header binds to that account only', () => {
  const body = '{}';
  const r = signedReq('alice-secret', body);
  assert.equal(
    resolveAccountId({ headerAccount: 'alice', rawBody: body, ts: r.ts, sig: r.sig },
      CANDIDATES, LEGACY),
    'alice',
  );
});

test('resolveAccountId: header + wrong secret is rejected, never cross-resolves', () => {
  const body = '{}';
  // signed with bob's secret but claiming alice → must be null, NOT 'bob'
  const r = signedReq('bob-secret', body);
  assert.equal(
    resolveAccountId({ headerAccount: 'alice', rawBody: body, ts: r.ts, sig: r.sig },
      CANDIDATES, LEGACY),
    null,
  );
});

test('resolveAccountId: unknown header account is rejected even with a valid legacy sig', () => {
  const body = '{}';
  const r = signedReq('legacy-secret', body);
  assert.equal(
    resolveAccountId({ headerAccount: 'mallory', rawBody: body, ts: r.ts, sig: r.sig },
      CANDIDATES, LEGACY),
    null,
  );
});

test('resolveAccountId: legacy env secret falls back to default', () => {
  const body = '{}';
  const r = signedReq('legacy-secret', body);
  assert.equal(
    resolveAccountId({ headerAccount: null, rawBody: body, ts: r.ts, sig: r.sig },
      CANDIDATES, LEGACY),
    'default',
  );
});

test('resolveAccountId: garbage signature resolves nowhere', () => {
  assert.equal(
    resolveAccountId({ headerAccount: null, rawBody: '{}', ts: '1', sig: 'nope' },
      CANDIDATES, LEGACY),
    null,
  );
  assert.equal(
    resolveAccountId({ headerAccount: null, rawBody: '{}', ts: '1', sig: 'nope' },
      CANDIDATES, null),
    null,
  );
});

// ---------------------------------------------------------------------------
// 003 multi-Luna: per-account stats breakdown
// ---------------------------------------------------------------------------

const { buildAccountsBreakdown } = await import('../src/stats.js');

test('buildAccountsBreakdown: merges registry rows, live state, and 24h counts', () => {
  const rows = [
    { account_id: 'alice', status: 'open', self_jid: null, sent_today: 3,
      daily_cap: 100, inbound_url: 'https://alice.fly.dev/api/p/plugin-whatsapp/inbound',
      last_seen: new Date('2026-07-04T10:00:00Z'), enabled: true },
    { account_id: 'bob', status: 'created', self_jid: null, sent_today: 0,
      daily_cap: null, inbound_url: null, last_seen: null, enabled: true },
  ];
  const live = { alice: { status: 'open', connected: true, self_jid: '1@s.whatsapp.net', has_qr: false } };
  const per24 = { alice: { in_24h: '10', out_24h: '7' } };
  const out = buildAccountsBreakdown(rows, live, per24, 300);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    account_id: 'alice', status: 'open', connected: true,
    self_jid: '1@s.whatsapp.net', has_qr: false, inbound_host: 'alice.fly.dev',
    messages_24h_in: 10, messages_24h_out: 7, sent_today: 3, daily_cap: 100,
    last_seen: '2026-07-04T10:00:00.000Z', enabled: true,
  });
  // bob: no live session, no traffic → registry values + zeroes + default cap
  assert.equal(out[1].connected, false);
  assert.equal(out[1].status, 'created');
  assert.equal(out[1].messages_24h_in, 0);
  assert.equal(out[1].daily_cap, 300);
  assert.equal(out[1].inbound_host, null);
});

// ---------------------------------------------------------------------------
// 003 multi-Luna: Session state machine basics (no network)
// ---------------------------------------------------------------------------

test('Session: constructor derives state from its registry row', () => {
  const s = new Session({
    account_id: 'acme', secret: 'sec', inbound_url: 'https://x/inbound',
    daily_cap: 42, status: 'linking', self_jid: '9725@s.whatsapp.net',
  });
  assert.equal(s.accountId, 'acme');
  assert.equal(s.dailyCap, 42);
  assert.equal(s.selfNumber, '9725');
  assert.ok(s.authDir.endsWith('/acme'));
  const conn = s.getConnState();
  assert.equal(conn.connected, false);
  assert.equal(conn.status, 'linking');
});

test('Session: a row that claims open starts as starting (socket not up yet)', () => {
  const s = new Session({ account_id: 'a', secret: 's', status: 'open' });
  assert.equal(s.getConnState().status, 'starting');
});

test('Session: updateRoute swaps inbound/secret/cap live', () => {
  const s = new Session({ account_id: 'a', secret: 'old', daily_cap: 10 });
  s.updateRoute({ inbound_url: 'https://new/inbound', secret: 'new', daily_cap: null });
  assert.equal(s.inboundUrl, 'https://new/inbound');
  assert.equal(s.secret, 'new');
  assert.equal(s.dailyCap, 300); // falls back to config default
});

test('Session: sends refuse when the socket is not open', async () => {
  const s = new Session({ account_id: 'a', secret: 's' });
  await assert.rejects(() => s.sendText('x@s.whatsapp.net', 'hi'), /not connected/);
  await assert.rejects(() => s.react('x@s.whatsapp.net', 'ID', '❤️'), /not connected/);
});

test('Session: stop clears watchdog and blocks reconnects', async () => {
  const s = new Session({ account_id: 'a', secret: 's' });
  s.startWatchdog();
  assert.ok(s.watchdogTimer);
  await s.stop();
  assert.equal(s.watchdogTimer, null);
  assert.equal(s.stopped, true);
  s.scheduleReconnect();
  assert.equal(s.reconnecting, false); // no-op after stop
  assert.equal(s.getConnState().status, 'disabled');
});
