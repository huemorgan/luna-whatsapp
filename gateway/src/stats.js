// Pure assembly of the /stats payload for the luna-service monitoring page.
// No I/O here — index.js gathers the pieces, this shapes them (unit-testable).

const num = (v) => (v == null ? 0 : Number(v));

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// 003 multi-Luna: per-account rows for /stats.accounts[]. accountRows are the
// registry rows; liveStates maps account_id -> getConnState() of the running
// session; perAccount24h maps account_id -> {in_24h, out_24h}.
export function buildAccountsBreakdown(accountRows, liveStates, perAccount24h, defaultCap) {
  return (accountRows || []).map((row) => {
    const live = liveStates?.[row.account_id];
    const m = perAccount24h?.[row.account_id];
    return {
      account_id: row.account_id,
      status: live?.status ?? row.status,
      connected: live ? live.connected : row.status === 'open',
      self_jid: live?.self_jid ?? row.self_jid ?? null,
      has_qr: live?.has_qr ?? false,
      inbound_host: hostOf(row.inbound_url),
      messages_24h_in: num(m?.in_24h),
      messages_24h_out: num(m?.out_24h),
      sent_today: row.sent_today ?? 0,
      daily_cap: row.daily_cap ?? num(defaultCap),
      last_seen: iso(row.last_seen),
      enabled: row.enabled !== false,
    };
  });
}

export function buildStatsPayload({ conn, state, stats, cap, version, dbLatencyMs, dbError, accounts }) {
  const mem = process.memoryUsage();
  const base = {
    ...conn,
    uptime_s: Math.round(process.uptime()),
    version: version || '0.0.0',
    node: process.version,
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    sent_today: state?.sent_today ?? 0,
    send_daily_cap: num(cap),
  };

  if (dbError || !stats) {
    // Socket state is still useful when Postgres is down — the page must be
    // able to show "server up, DB down" rather than a blanket error.
    return { ...base, db: { ok: false, error: dbError || 'no stats' } };
  }

  const w = stats.windows || {};
  return {
    ...base,
    db: { ok: true, latency_ms: dbLatencyMs },
    totals: {
      messages: num(w.total_messages),
      chats: num(w.total_chats),
      users: num(w.total_users),
    },
    last_hour: {
      messages_in: num(w.in_1h),
      messages_out: num(w.out_1h),
      active_chats: num(w.chats_1h),
      active_users: num(w.users_1h),
    },
    last_24h: {
      messages_in: num(w.in_24h),
      messages_out: num(w.out_24h),
      active_chats: num(w.chats_24h),
      active_users: num(w.users_24h),
    },
    media_24h: Object.fromEntries((stats.media || []).map((r) => [r.kind, num(r.n)])),
    hourly: (stats.hourly || []).map((r) => ({
      hour: iso(r.hour),
      in: num(r.inbound),
      out: num(r.outbound),
    })),
    last_message_at: iso(w.last_message_at),
    ...(accounts ? { accounts } : {}),
  };
}
