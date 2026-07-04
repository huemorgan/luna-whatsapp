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
  // Legacy single-account HMAC secret. Since 003 (multi-Luna) accounts live in
  // the whatsapp_accounts registry with per-account secrets; this env var only
  // seeds the `default` account on first boot and stays a verification
  // fallback for it. Optional: a fresh multi-tenant deploy can run without it.
  sharedSecret: opt('WA_SHARED_SECRET', ''),
  // Protects the /qr page and the /accounts admin API.
  adminKey: req('GATEWAY_ADMIN_KEY'),
  // Legacy inbound target — seeds the `default` account's inbound_url.
  lunaInboundUrl: opt('LUNA_INBOUND_URL', ''),
  databaseUrl: req('DATABASE_URL'),
  // Baileys auth root — on Render this is the mounted persistent disk. Each
  // account keeps its session files in <authDir>/<account_id>/.
  authDir: opt('WA_AUTH_DIR', '/data/wa-auth'),
  // Which registry rows this instance owns (sharding hook; single instance now).
  gatewayId: opt('GATEWAY_ID', 'gw-1'),
  // Legacy name for the seeded account (kept for the env-seed path only).
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
