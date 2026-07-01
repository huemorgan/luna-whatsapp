// Shared HMAC scheme for gateway <-> Luna plugin.
//
// Signature is hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`)).
// Headers:
//   x-wa-timestamp : unix seconds when signed
//   x-wa-signature : the hex digest
// Verifier rejects a skew > SKEW_SECONDS to blunt replay attacks.
// The Python plugin (plugin_whatsapp/hmac.py) implements the identical scheme.

import crypto from 'node:crypto';

const SKEW_SECONDS = 300;

export function sign(secret, rawBody, timestamp) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return { timestamp: ts, signature: mac };
}

export function verify(secret, rawBody, timestamp, signature) {
  if (!timestamp || !signature) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (!Number.isFinite(skew) || skew > SKEW_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
