// Forward a normalized inbound message to the Luna plugin, HMAC-signed.
// Fire-and-forget with a couple of retries; the message is already durably in
// Postgres, so a failed forward is recoverable (Luna can also poll/replay later).

import { sign } from './hmac.js';
import { config } from './config.js';

export async function forwardInbound(envelope) {
  if (!config.lunaInboundUrl) {
    // Not wired yet (e.g. before the tunnel is up). Capture still happened.
    return { ok: false, skipped: true };
  }
  const body = JSON.stringify(envelope);
  const { timestamp, signature } = sign(config.sharedSecret, body);

  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(config.lunaInboundUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wa-timestamp': timestamp,
          'x-wa-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return { ok: true };
      lastErr = new Error(`inbound HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  console.error('[inbound] forward failed:', lastErr?.message);
  return { ok: false, error: lastErr?.message };
}
