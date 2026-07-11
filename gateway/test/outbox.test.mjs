// 006 anti-ban send discipline tests (node --test). Pure logic only — the
// worker runs against an in-memory store double that mirrors pgOutboxStore
// semantics (including the queued→sending claim guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WA_SHARED_SECRET ||= 'unit-test-secret';
process.env.GATEWAY_ADMIN_KEY ||= 'unit-test-admin';
process.env.DATABASE_URL ||= 'postgres://localhost/none';

const {
  parseRange, gapRangesFromConfig, classify, gapMsFor,
  SameTextGuard, estimateWaitMs, OutboxWorker, CONVERSATIONAL_WINDOW_MS,
} = await import('../src/outbox.js');
const { detectRestrictionSignal, pickBrowser, Session } = await import('../src/session.js');
const { config } = await import('../src/config.js');

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('parseRange: "lo-hi", single number, junk → fallback, swapped bounds', () => {
  assert.deepEqual(parseRange('1500-4000'), [1500, 4000]);
  assert.deepEqual(parseRange(' 90000 - 240000 '), [90000, 240000]);
  assert.deepEqual(parseRange('5000'), [5000, 5000]);
  assert.deepEqual(parseRange('garbage', [7, 9]), [7, 9]);
  assert.deepEqual(parseRange(null, [7, 9]), [7, 9]);
  assert.deepEqual(parseRange('400-100'), [100, 400]);
});

test('gapRangesFromConfig reads the three class ranges', () => {
  const r = gapRangesFromConfig({
    gapConversationalMs: '1-2', gapWarmMs: '3-4', gapColdMs: '5-6',
  });
  assert.deepEqual(r, { conversational: [1, 2], warm: [3, 4], cold: [5, 6] });
});

test('classify: never-inbound → cold, recent → conversational, old → warm', () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  assert.equal(classify(null, now), 'cold');
  assert.equal(classify(undefined, now), 'cold');
  assert.equal(classify('not a date', now), 'cold');
  assert.equal(classify(new Date(now - 60_000), now), 'conversational');
  assert.equal(classify(new Date(now - CONVERSATIONAL_WINDOW_MS), now), 'conversational');
  assert.equal(classify(new Date(now - CONVERSATIONAL_WINDOW_MS - 1), now), 'warm');
  assert.equal(classify(new Date(now - 30 * 24 * 3600_000), now), 'warm');
});

test('gapMsFor: samples inside the class range; warm-up doubles it', () => {
  const ranges = { conversational: [100, 200], warm: [300, 400], cold: [500, 600] };
  assert.equal(gapMsFor('warm', { ranges, rand: () => 0 }), 300);
  assert.equal(gapMsFor('warm', { ranges, rand: () => 1 }), 400);
  assert.equal(gapMsFor('cold', { ranges, rand: () => 0.5 }), 550);
  assert.equal(gapMsFor('cold', { ranges, rand: () => 0.5, warmup: true }), 1100);
  // unknown class falls back to the default warm range, never to zero
  assert.equal(gapMsFor('nope', { ranges, rand: () => 0 }), 8000);
});

test('estimateWaitMs: mid-gap of the queue plus the new row', () => {
  const ranges = { conversational: [100, 200], warm: [300, 400], cold: [500, 600] };
  // empty queue → just the new row's mid-gap
  assert.equal(estimateWaitMs([], 'warm', { ranges }), 350);
  assert.equal(estimateWaitMs(['conversational', 'cold'], 'warm', { ranges }), 150 + 550 + 350);
  assert.equal(estimateWaitMs([], 'warm', { ranges, warmup: true }), 700);
});

test('detectRestrictionSignal: matches the enforcement lines, ignores noise', () => {
  assert.equal(detectRestrictionSignal(['error 463: account restricted or missing tctoken for contact']), true);
  assert.equal(detectRestrictionSignal([{ msg: 'stream errored', node: { attrs: { reason: 'device_removed' } } }]), true);
  assert.equal(detectRestrictionSignal(['connection closed, reconnecting']), false);
  assert.equal(detectRestrictionSignal([]), false);
  assert.equal(detectRestrictionSignal(undefined), false);
});

test('pickBrowser: default keeps the legacy tuple; others are deterministic and valid', () => {
  assert.deepEqual(pickBrowser('default'), ['Luna WhatsApp', 'Chrome', '1.0.0']);
  const a = pickBrowser('acme-agent');
  assert.deepEqual(pickBrowser('acme-agent'), a); // stable across calls
  assert.equal(a.length, 3);
  a.forEach((part) => assert.equal(typeof part, 'string'));
});

// ---------------------------------------------------------------------------
// SameTextGuard — the burst signature that got the account restricted
// ---------------------------------------------------------------------------

test('SameTextGuard: normalizes whitespace/case', () => {
  assert.equal(SameTextGuard.normalize('  Hi   There\n'), 'hi there');
  assert.equal(SameTextGuard.normalize(null), '');
});

test('SameTextGuard: fires on the 3rd distinct chat with the same text', () => {
  let t = 0;
  const g = new SameTextGuard({ now: () => t });
  assert.equal(g.note('Team meeting at 5', 'a@s.whatsapp.net'), false);
  assert.equal(g.note('team  MEETING at 5', 'b@s.whatsapp.net'), false);
  assert.equal(g.note('Team meeting at 5', 'c@s.whatsapp.net'), true);
  // repeats to the same chat don't add distinct chats
  assert.equal(g.note('Different text entirely', 'a@s.whatsapp.net'), false);
  assert.equal(g.note('Different text entirely', 'a@s.whatsapp.net'), false);
});

test('SameTextGuard: entries expire outside the window', () => {
  let t = 0;
  const g = new SameTextGuard({ windowMs: 1000, now: () => t });
  g.note('hello', 'a@x');
  g.note('hello', 'b@x');
  t = 2000; // both entries expired
  assert.equal(g.note('hello', 'c@x'), false);
});

test('SameTextGuard: empty text never flags', () => {
  const g = new SameTextGuard();
  assert.equal(g.note('', 'a@x'), false);
  assert.equal(g.note(undefined, 'b@x'), false);
});

// ---------------------------------------------------------------------------
// Session breaker / warm-up (no socket, no Postgres — setAccountState is
// stubbed out so nothing touches the pool)
// ---------------------------------------------------------------------------

function bareSession(row = {}) {
  const s = new Session({ account_id: 'test', secret: 's', ...row });
  s.setAccountState = async () => {}; // keep unit tests off the pool
  return s;
}

test('breaker: trip freezes sends with a 503-coded error and parks the queue', async () => {
  const s = bareSession();
  let held = 0;
  s.outbox = { holdAll: async () => { held += 1; }, stop() {}, wake() {} };
  assert.equal(s.breakerOpen(), false);
  s.tripBreaker('error 463 in log');
  assert.equal(s.breakerOpen(), true);
  assert.equal(s.coldFrozen(), true);
  assert.equal(held, 1);
  await assert.rejects(() => s.sendText('x@s.whatsapp.net', 'hi'),
    (e) => e.status === 503 && e.code === 'breaker_open');
  await assert.rejects(() => s.sendMedia('x@s.whatsapp.net', 'image', Buffer.from('x')),
    (e) => e.code === 'breaker_open');
});

test('breaker: a second trip does not extend the window', () => {
  const s = bareSession();
  s.tripBreaker('first');
  const until = s.breakerUntil;
  s.tripBreaker('second');
  assert.equal(s.breakerUntil, until);
  assert.equal(s.breakerReason, 'first');
});

test('breaker: releaseBreaker clears breaker and cold freeze', async () => {
  const s = bareSession();
  s.tripBreaker('x');
  await s.releaseBreaker();
  assert.equal(s.breakerOpen(), false);
  assert.equal(s.coldFrozen(), false);
  assert.equal(s.breakerReason, null);
});

test('breaker: restored from the registry row on construction', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const s = bareSession({ breaker_until: future, breaker_reason: 'persisted' });
  assert.equal(s.breakerOpen(), true);
  assert.equal(s.breakerReason, 'persisted');
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(bareSession({ breaker_until: past }).breakerOpen(), false);
});

test('warm-up: fresh link halves the daily cap; expiry restores it', () => {
  const s = bareSession({ daily_cap: 100 });
  assert.equal(s.inWarmup(), false);
  assert.equal(s.effectiveDailyCap(), 100);
  s.linkedAt = Date.now();
  assert.equal(s.inWarmup(), true);
  assert.equal(s.effectiveDailyCap(), 50);
  s.linkedAt = Date.now() - (config.warmupHours + 1) * 3600_000;
  assert.equal(s.inWarmup(), false);
  assert.equal(s.effectiveDailyCap(), 100);
});

// ---------------------------------------------------------------------------
// OutboxWorker against an in-memory store double
// ---------------------------------------------------------------------------

let nextId = 1;
function memStore() {
  const rows = [];
  const byId = (id) => rows.find((r) => r.id === id) ?? null;
  return {
    rows,
    async enqueue({ account_id, chat_jid, kind, payload, cls, not_before }) {
      const row = {
        id: `row-${nextId++}`, account_id, chat_jid, kind,
        payload: JSON.stringify(payload), class: cls,
        status: 'queued', not_before: new Date(not_before ?? Date.now()),
        attempts: 0, last_error: null, wa_msg_id: null,
        created_at: new Date(), sent_at: null,
      };
      rows.push(row);
      return row;
    },
    async nextQueued(accountId) {
      return rows
        .filter((r) => r.account_id === accountId && r.status === 'queued')
        .sort((a, b) => (a.not_before - b.not_before) || (a.created_at - b.created_at))[0] ?? null;
    },
    async mark(id, patch) {
      const row = byId(id);
      if (!row) return null;
      if (patch.status === 'sending' && row.status !== 'queued') return null; // claim guard
      Object.assign(row, patch);
      return { ...row };
    },
    async get(id, accountId) {
      const row = byId(id);
      return row && row.account_id === accountId ? { ...row } : null;
    },
    async pending(accountId) {
      return rows.filter((r) => r.account_id === accountId
        && ['queued', 'sending', 'held'].includes(r.status));
    },
    async cancel(id, accountId) {
      const row = byId(id);
      if (!row || row.account_id !== accountId || row.status !== 'queued') return null;
      row.status = 'canceled';
      return { ...row };
    },
    async holdQueued(accountId) {
      let n = 0;
      for (const r of rows) {
        if (r.account_id === accountId && r.status === 'queued') { r.status = 'held'; n += 1; }
      }
      return n;
    },
    async releaseHeld(accountId) {
      let n = 0;
      for (const r of rows) {
        if (r.account_id === accountId && r.status === 'held') {
          r.status = 'queued'; r.not_before = new Date(); n += 1;
        }
      }
      return n;
    },
    async recoverSending(accountId) {
      let n = 0;
      for (const r of rows) {
        if (r.account_id === accountId && r.status === 'sending') { r.status = 'queued'; n += 1; }
      }
      return n;
    },
    async coldCounts() { return { today: 0, hour: 0 }; },
    async lastInboundAt() { return null; },
    async queueDepth(accountId) {
      return rows.filter((r) => r.account_id === accountId && r.status === 'queued').length;
    },
  };
}

// Tiny real-timer gaps so a full drain finishes in milliseconds.
const FAST = { conversational: [1, 2], warm: [1, 2], cold: [1, 2] };

function fakeSender({ deliver, breaker = () => false, warmup = () => false } = {}) {
  const sent = [];
  return {
    sent,
    breakerOpen: breaker,
    inWarmup: warmup,
    async deliverOutboxRow(row) {
      if (deliver) return deliver(row, sent);
      sent.push(row.id);
      return { wa_msg_id: `WA-${row.id}` };
    },
  };
}

function worker(store, sender, over = {}) {
  return new OutboxWorker({
    accountId: 'test', store, sender, ranges: FAST, idlePollMs: 5, ...over,
  });
}

async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('worker: drains queued rows serially in FIFO order', async () => {
  const store = memStore();
  const sender = fakeSender();
  const a = await store.enqueue({ account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: '1' }, cls: 'warm' });
  const b = await store.enqueue({ account_id: 'test', chat_jid: 'b@x', kind: 'text', payload: { text: '2' }, cls: 'warm' });
  const w = worker(store, sender);
  w.start();
  try {
    await until(() => sender.sent.length === 2);
    assert.deepEqual(sender.sent, [a.id, b.id]);
    assert.equal((await store.get(a.id, 'test')).status, 'sent');
    assert.equal((await store.get(b.id, 'test')).wa_msg_id, `WA-${b.id}`);
  } finally { w.stop(); }
});

test('worker: enforces the pacing gap between consecutive sends', async () => {
  const store = memStore();
  const stamps = [];
  const sender = fakeSender({
    deliver: (row) => { stamps.push(Date.now()); return { wa_msg_id: row.id }; },
  });
  for (let i = 0; i < 3; i++) {
    await store.enqueue({ account_id: 'test', chat_jid: `${i}@x`, kind: 'text', payload: { text: 'x' }, cls: 'warm' });
  }
  const w = worker(store, sender, { ranges: { ...FAST, warm: [40, 41] } });
  w.start();
  try {
    await until(() => stamps.length === 3);
    // The gap applies between sends (not before the first). Allow timer slack.
    assert.ok(stamps[1] - stamps[0] >= 35, `gap1 ${stamps[1] - stamps[0]}ms`);
    assert.ok(stamps[2] - stamps[1] >= 35, `gap2 ${stamps[2] - stamps[1]}ms`);
  } finally { w.stop(); }
});

test('worker: transient failure retries with backoff; permanent after 3 attempts', async () => {
  const store = memStore();
  let calls = 0;
  const sender = fakeSender({
    deliver: () => { calls += 1; throw new Error('socket hiccup'); },
  });
  const row = await store.enqueue({ account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'x' }, cls: 'warm' });
  const w = worker(store, sender);
  // shrink the retry backoff so the test runs in ms: monkey-patch now/not_before path
  const origMark = store.mark.bind(store);
  store.mark = async (id, patch) => {
    if (patch.not_before) patch.not_before = new Date(); // retry immediately
    return origMark(id, patch);
  };
  w.start();
  try {
    await until(async () => (await store.get(row.id, 'test')).status === 'failed');
    const final = await store.get(row.id, 'test');
    assert.equal(calls, 3);
    assert.equal(final.attempts, 3);
    assert.match(final.last_error, /socket hiccup/);
  } finally { w.stop(); }
});

test('worker: "cap reached" is permanent on the first attempt', async () => {
  const store = memStore();
  const sender = fakeSender({ deliver: () => { throw new Error('daily send cap reached'); } });
  const row = await store.enqueue({ account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'x' }, cls: 'warm' });
  const w = worker(store, sender);
  w.start();
  try {
    await until(async () => (await store.get(row.id, 'test')).status === 'failed');
    assert.equal((await store.get(row.id, 'test')).attempts, 1);
  } finally { w.stop(); }
});

test('worker: open breaker parks queued rows as held; release re-queues and sends', async () => {
  const store = memStore();
  let breakerOn = true;
  const sender = fakeSender({ breaker: () => breakerOn });
  const row = await store.enqueue({ account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'x' }, cls: 'warm' });
  const w = worker(store, sender);
  w.start();
  try {
    await until(async () => (await store.get(row.id, 'test')).status === 'held');
    // nothing fires while held, even though the worker keeps polling
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sender.sent.length, 0);
    breakerOn = false;
    await store.releaseHeld('test');
    w.wake();
    await until(() => sender.sent.length === 1);
    assert.equal((await store.get(row.id, 'test')).status, 'sent');
  } finally { w.stop(); }
});

test('worker: a row canceled before claim is never delivered', async () => {
  const store = memStore();
  const sender = fakeSender();
  // parked in the future so we can cancel before the worker claims it
  const row = await store.enqueue({
    account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'x' },
    cls: 'warm', not_before: Date.now() + 60_000,
  });
  const w = worker(store, sender);
  w.start();
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(await store.cancel(row.id, 'test'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sender.sent.length, 0);
    assert.equal((await store.get(row.id, 'test')).status, 'canceled');
  } finally { w.stop(); }
});

test('worker: recovers rows stuck in sending from a previous process', async () => {
  const store = memStore();
  const sender = fakeSender();
  const row = await store.enqueue({ account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'x' }, cls: 'warm' });
  store.rows[0].status = 'sending'; // simulate a crash mid-send
  const w = worker(store, sender);
  w.start();
  try {
    await until(() => sender.sent.length === 1);
    assert.equal((await store.get(row.id, 'test')).status, 'sent');
  } finally { w.stop(); }
});

test('worker: waitForSettle resolves sent, failed, and times out for parked rows', async () => {
  const store = memStore();
  const sender = fakeSender({
    deliver: (row) => {
      const p = JSON.parse(row.payload);
      if (p.text === 'boom') throw new Error('daily send cap reached');
      return { wa_msg_id: 'OK1' };
    },
  });
  const w = worker(store, sender);
  w.start();
  try {
    const good = await store.enqueue({ account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'ok' }, cls: 'warm' });
    const settled = await w.waitForSettle(good.id, 2000);
    assert.equal(settled.status, 'sent');
    assert.equal(settled.wa_msg_id, 'OK1');

    const bad = await store.enqueue({ account_id: 'test', chat_jid: 'b@x', kind: 'text', payload: { text: 'boom' }, cls: 'warm' });
    const failed = await w.waitForSettle(bad.id, 2000);
    assert.equal(failed.status, 'failed');
    assert.match(failed.last_error, /cap reached/);

    const parked = await store.enqueue({
      account_id: 'test', chat_jid: 'c@x', kind: 'text', payload: { text: 'later' },
      cls: 'warm', not_before: Date.now() + 60_000,
    });
    assert.equal(await w.waitForSettle(parked.id, 50), null);
  } finally { w.stop(); }
});

test('worker: honors not_before scheduling', async () => {
  const store = memStore();
  const sender = fakeSender();
  const t0 = Date.now();
  await store.enqueue({
    account_id: 'test', chat_jid: 'a@x', kind: 'text', payload: { text: 'x' },
    cls: 'warm', not_before: t0 + 60,
  });
  const w = worker(store, sender);
  w.start();
  try {
    await until(() => sender.sent.length === 1);
    assert.ok(Date.now() - t0 >= 55, 'sent before not_before');
  } finally { w.stop(); }
});
