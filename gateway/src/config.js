// Central env parsing for the gateway. Fail loud on missing critical secrets.

function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function opt(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const config = {
  port: parseInt(opt('PORT', '10000'), 10),
  // HMAC shared secret between gateway <-> Luna plugin.
  sharedSecret: req('WA_SHARED_SECRET'),
  // Protects the /qr linking page.
  adminKey: req('GATEWAY_ADMIN_KEY'),
  // Where inbound WhatsApp events are POSTed (the Luna plugin route).
  // e.g. https://<tunnel>/api/p/plugin-whatsapp/inbound
  lunaInboundUrl: opt('LUNA_INBOUND_URL', ''),
  databaseUrl: req('DATABASE_URL'),
  // Baileys auth dir — on Render this is the mounted persistent disk.
  authDir: opt('WA_AUTH_DIR', '/data/wa-auth'),
  // Label for the linked account (multi-account is Phase 2; single for MVP).
  account: opt('WA_ACCOUNT', 'default'),
  // Ban-risk guard: max outbound messages per day.
  sendDailyCap: parseInt(opt('WA_SEND_DAILY_CAP', '300'), 10),
  // Baileys socket timings (research §2).
  keepAliveIntervalMs: parseInt(opt('WA_KEEPALIVE_MS', '15000'), 10),
  connectTimeoutMs: parseInt(opt('WA_CONNECT_TIMEOUT_MS', '60000'), 10),
  defaultQueryTimeoutMs: parseInt(opt('WA_QUERY_TIMEOUT_MS', '60000'), 10),
  // Force a reconnect if no application message handled for this long while
  // the socket looks "open" (zombie-socket backstop).
  appSilenceBackstopMs: parseInt(opt('WA_APP_SILENCE_MS', '900000'), 10),
};
