// 006 anti-ban send discipline: the outbound queue.
//
// Every send (/send, /send-media, /react) becomes a whatsapp_outbox row; one
// OutboxWorker per account drains them serially with a randomized gap between
// ANY two sends, sized by recipient class. A burst is impossible at this layer
// no matter what the agent, the plugin, or a retry loop upstream does.
//
// Pure helpers (classify, gapMsFor, SameTextGuard, …) are exported for unit
// tests; the worker takes an injectable store (pgOutboxStore in production,
// an in-memory double in tests) and a sender (the Session).

import { EventEmitter } from 'node:events';
import { config } from './config.js';

export const CONVERSATIONAL_WINDOW_MS = 15 * 60 * 1000;

// "lo-hi" (ms) → [lo, hi]. Tolerates a single number ("5000").
export function parseRange(str, fallback = [1000, 2000]) {
  const m = String(str ?? '').match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
  if (!m) return fallback;
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  return hi >= lo ? [lo, hi] : [hi, lo];
}

export function gapRangesFromConfig(cfg = config) {
  return {
    conversational: parseRange(cfg.gapConversationalMs, [1500, 4000]),
    warm: parseRange(cfg.gapWarmMs, [8000, 25000]),
    cold: parseRange(cfg.gapColdMs, [90000, 240000]),
  };
}

// Recipient class from "when did this chat last write to us":
//   conversational — inbound within the last 15 min (replying in a live chat)
//   warm           — any inbound ever (a tctoken exists on their side)
//   cold           — never messaged us: the enforcement trigger (463)
export function classify(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return 'cold';
  const t = new Date(lastInboundAt).getTime();
  if (Number.isNaN(t)) return 'cold';
  return now - t <= CONVERSATIONAL_WINDOW_MS ? 'conversational' : 'warm';
}

// Randomized pacing gap for a class; warm-up doubles everything.
export function gapMsFor(cls, { ranges, warmup = false, rand = Math.random } = {}) {
  const r = (ranges ?? gapRangesFromConfig())[cls] ?? [8000, 25000];
  const gap = r[0] + rand() * (r[1] - r[0]);
  return Math.round(warmup ? gap * 2 : gap);
}

// The signature that got the account restricted: identical text to several
// distinct chats in a short window. Tracks per-account; when the same
// normalized text reaches `threshold` distinct chats inside `windowMs`, the
// caller must re-class the send as cold (pacing + budget).
export class SameTextGuard {
  constructor({ windowMs = 10 * 60 * 1000, threshold = 3, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.now = now;
    this.seen = new Map(); // normText -> [{chat, at}]
  }

  static normalize(text) {
    return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Record text→chat and return true when this send is part of a burst.
  note(text, chatJid) {
    const key = SameTextGuard.normalize(text);
    if (!key) return false;
    const t = this.now();
    const entries = (this.seen.get(key) ?? []).filter((e) => t - e.at <= this.windowMs);
    if (!entries.some((e) => e.chat === chatJid)) entries.push({ chat: chatJid, at: t });
    this.seen.set(key, entries);
    if (this.seen.size > 500) this.gc(t);
    return new Set(entries.map((e) => e.chat)).size >= this.threshold;
  }

  gc(t = this.now()) {
    for (const [key, entries] of this.seen) {
      const live = entries.filter((e) => t - e.at <= this.windowMs);
      if (live.length) this.seen.set(key, live);
      else this.seen.delete(key);
    }
  }
}

// Rough delivery estimate for a new row: mid-gap of everything already queued
// plus this row's own class gap. Honest enough for "sync or 202?" and an eta.
export function estimateWaitMs(pendingClasses, newClass, { ranges, warmup = false } = {}) {
  const r = ranges ?? gapRangesFromConfig();
  const mid = (cls) => {
    const [lo, hi] = r[cls] ?? r.warm;
    return ((lo + hi) / 2) * (warmup ? 2 : 1);
  };
  let total = 0;
  for (const cls of pendingClasses) total += mid(cls);
  return Math.round(total + mid(newClass));
}

// One drain loop per account. Serial by construction; enforces the class gap
// between consecutive sends, honors not_before (retry backoff), parks on
// breaker/hold, and emits `settled:<id>` so the HTTP layer can answer
// synchronously when the queue is short.
export class OutboxWorker extends EventEmitter {
  // sender: { deliverOutboxRow(row) -> {wa_msg_id}, breakerOpen() -> bool,
  //           inWarmup() -> bool, holdOutbox() (session tripBreaker calls store) }
  constructor({ accountId, store, sender, ranges, idlePollMs = 3000, now = Date.now }) {
    super();
    this.accountId = accountId;
    this.store = store;
    this.sender = sender;
    this.ranges = ranges ?? gapRangesFromConfig();
    this.idlePollMs = idlePollMs;
    this.now = now;
    this.lastSentAt = 0;
    this.running = false;
    this._wake = null;
    this._timer = null;
    this.setMaxListeners(100);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop().catch((e) =>
      console.error('[outbox:%s] drain loop died:', this.accountId, e));
  }

  stop() {
    this.running = false;
    this.wake();
  }

  // New work or state change — cut any idle/pacing sleep short (pacing sleeps
  // re-check the clock, so waking early never violates the gap).
  wake() {
    this._wake?.();
  }

  // Breaker trip: park every queued row now (the loop also re-checks, but the
  // trip must not wait for the next iteration).
  async holdAll() {
    try {
      return await this.store.holdQueued(this.accountId);
    } catch (e) {
      console.error('[outbox:%s] holdAll failed:', this.accountId, e.message);
      return 0;
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._wake = resolve;
      this._timer = setTimeout(resolve, ms);
    }).finally(() => {
      clearTimeout(this._timer);
      this._wake = null;
    });
  }

  async _loop() {
    await this.store.recoverSending(this.accountId).catch(() => {});
    while (this.running) {
      let row;
      try {
        row = await this.store.nextQueued(this.accountId);
      } catch (e) {
        console.error('[outbox:%s] nextQueued failed:', this.accountId, e.message);
        await this._sleep(this.idlePollMs);
        continue;
      }
      if (!row) {
        await this._sleep(this.idlePollMs);
        continue;
      }

      // Breaker tripped between enqueue and drain — park the whole queue.
      if (this.sender.breakerOpen?.()) {
        await this.store.holdQueued(this.accountId).catch(() => {});
        await this._sleep(this.idlePollMs);
        continue;
      }

      // Honor retry backoff, then the pacing gap since the previous send.
      const notBefore = new Date(row.not_before).getTime();
      const gap = gapMsFor(row.class, {
        ranges: this.ranges, warmup: !!this.sender.inWarmup?.(),
      });
      const dueAt = Math.max(notBefore, this.lastSentAt + gap);
      const wait = dueAt - this.now();
      if (wait > 0) {
        await this._sleep(Math.min(wait, 60000));
        continue; // re-check everything after any sleep (wake, breaker, cancel)
      }

      await this._deliver(row);
    }
  }

  async _deliver(row) {
    try {
      const claimed = await this.store.mark(row.id, { status: 'sending' });
      if (!claimed) return; // canceled under us
    } catch (e) {
      console.error('[outbox:%s] claim failed:', this.accountId, e.message);
      return;
    }
    try {
      const result = await this.sender.deliverOutboxRow(row);
      this.lastSentAt = this.now();
      const settled = await this.store.mark(row.id, {
        status: 'sent', wa_msg_id: result?.wa_msg_id ?? null, sent_at: new Date(),
      });
      this.emit(`settled:${row.id}`, settled ?? { ...row, status: 'sent', ...result });
    } catch (e) {
      const attempts = (row.attempts ?? 0) + 1;
      // Cap exhaustion is permanent for the day; a tripped breaker means the
      // row was held by tripBreaker — never spin retries on either.
      const permanent = attempts >= 3
        || /cap reached/i.test(e.message)
        || this.sender.breakerOpen?.();
      const status = this.sender.breakerOpen?.() ? 'held' : (permanent ? 'failed' : 'queued');
      const settled = await this.store.mark(row.id, {
        status, attempts, last_error: e.message,
        not_before: new Date(this.now() + 30000 * attempts),
      }).catch(() => null);
      if (status === 'failed') {
        this.emit(`settled:${row.id}`, settled ?? { ...row, status, last_error: e.message });
      }
      console.error('[outbox:%s] send %s → %s: %s', this.accountId, row.id, status, e.message);
    }
  }

  // Resolve when the row settles (sent/failed); null on timeout (still queued).
  waitForSettle(id, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeAllListeners(`settled:${id}`);
        resolve(null);
      }, timeoutMs);
      this.once(`settled:${id}`, (row) => {
        clearTimeout(timer);
        resolve(row);
      });
    });
  }
}
