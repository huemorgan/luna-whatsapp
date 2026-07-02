// Gateway unit tests (node --test). Pure logic only — no socket, no Postgres.
// Dummy env is set before importing modules that read config at load time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WA_SHARED_SECRET ||= 'unit-test-secret';
process.env.GATEWAY_ADMIN_KEY ||= 'unit-test-admin';
process.env.DATABASE_URL ||= 'postgres://localhost/none';

const { sign, verify } = await import('../src/hmac.js');
const { buildMediaContent, toMediaUpload, withComposing } = await import('../src/wa.js');

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
