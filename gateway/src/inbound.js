// Forward a normalized inbound message to the owning Luna, HMAC-signed with
// THAT account's secret (003 multi-Luna: each account routes to its own Luna).
// Fire-and-forget with a couple of retries; the message is already durably in
// Postgres, so a failed forward is recoverable (Luna can also poll/replay later).

import { sign } from './hmac.js';

export async function forwardInbound(envelope, { url, secret } = {}) {
  if (!url) {
    // Account not wired to a Luna yet. Capture still happened.
    return { ok: false, skipped: true };
  }
  const body = JSON.stringify(envelope);
  const { timestamp, signature } = sign(secret, body);

  // The plugin processes inbound synchronously: it runs a full agent turn (which
  // may call web/search/screenshot tools and take tens of seconds) and only then
  // returns. So the forward must tolerate a long turn. 120s covers rich turns; if
  // a turn genuinely needs longer, that's a turn bug, not a transport one.
  // Retries are for connection-level failures only, NOT timeouts: a timeout may
  // mean the turn is still running, and retrying would double-send. The inbound
  // is already durably in Postgres, so a dropped forward is recoverable.
  const maxAttempts = 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wa-timestamp': timestamp,
          'x-wa-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) return { ok: true };
      lastErr = new Error(`inbound HTTP ${res.status}`);
      // A timeout/abort should not be retried (see note above); only retry on a
      // clean non-OK HTTP status that isn't a server-busy signal.
      if (res.status >= 500) break;
    } catch (e) {
      lastErr = e;
      // AbortError = timeout → don't retry (turn may still be running).
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') break;
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  console.error('[inbound] forward failed:', lastErr?.message);
  return { ok: false, error: lastErr?.message };
}
