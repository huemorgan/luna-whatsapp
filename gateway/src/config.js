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
  // 006 anti-ban send discipline. WA_OUTBOX=0 is the escape hatch back to
  // direct (unpaced) sends.
  outboxEnabled: opt('WA_OUTBOX', '1') === '1',
  // Hold the HTTP request and answer synchronously when the queue can deliver
  // within this window (keeps single conversational sends feeling instant).
  syncWaitMs: parseInt(opt('WA_SYNC_WAIT_MS', '10000'), 10),
  // Randomized gap between ANY two sends, by recipient class ("lo-hi" ms).
  gapConversationalMs: opt('WA_GAP_CONV_MS', '1500-4000'),
  gapWarmMs: opt('WA_GAP_WARM_MS', '8000-25000'),
  gapColdMs: opt('WA_GAP_COLD_MS', '90000-240000'),
  // Cold contacts (never messaged us) are the enforcement trigger — budget them.
  coldDailyCap: parseInt(opt('WA_COLD_DAILY_CAP', '6'), 10),
  coldHourlyCap: parseInt(opt('WA_COLD_HOURLY_CAP', '2'), 10),
  // Circuit breaker after a restriction signal (463 / device_removed / 401).
  breakerHours: parseFloat(opt('WA_BREAKER_HOURS', '6')),
  coldFreezeHours: parseFloat(opt('WA_COLD_FREEZE_HOURS', '48')),
  // Probation window after a fresh QR link: halved caps, doubled gaps.
  warmupHours: parseFloat(opt('WA_WARMUP_HOURS', '72')),
  // 007 voice processing (ElevenLabs). No key → the feature is off: inbound
  // voice notes keep their empty body, /send-voice answers 503 voice_disabled.
  eleven: {
    apiKey: opt('ELEVENLABS_API_KEY', ''),
    voiceId: opt('ELEVENLABS_VOICE_ID', ''),
    ttsModel: opt('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5'),
    sttModel: opt('ELEVENLABS_STT_MODEL', 'scribe_v1'),
    // Ogg Opus @48kHz — WhatsApp's own voice-note codec, sent as-is.
    ttsFormat: opt('ELEVENLABS_TTS_FORMAT', 'opus_48000_64'),
    timeoutMs: parseInt(opt('ELEVENLABS_TIMEOUT_MS', '60000'), 10),
    // Don't burn STT credits on hour-long forwarded audio.
    maxSttSeconds: parseInt(opt('WA_STT_MAX_SECONDS', '600'), 10),
  },
  // Baileys socket timings (research §2).
  keepAliveIntervalMs: parseInt(opt('WA_KEEPALIVE_MS', '15000'), 10),
  connectTimeoutMs: parseInt(opt('WA_CONNECT_TIMEOUT_MS', '60000'), 10),
  defaultQueryTimeoutMs: parseInt(opt('WA_QUERY_TIMEOUT_MS', '60000'), 10),
  // Force a reconnect if no application message handled for this long while
  // the socket looks "open" (zombie-socket backstop).
  appSilenceBackstopMs: parseInt(opt('WA_APP_SILENCE_MS', '900000'), 10),
};
