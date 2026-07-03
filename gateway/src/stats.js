// Pure assembly of the /stats payload for the luna-service monitoring page.
// No I/O here — index.js gathers the pieces, this shapes them (unit-testable).

const num = (v) => (v == null ? 0 : Number(v));

export function buildStatsPayload({ conn, state, stats, cap, version, dbLatencyMs, dbError }) {
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
      hour: r.hour instanceof Date ? r.hour.toISOString() : r.hour,
      in: num(r.inbound),
      out: num(r.outbound),
    })),
    last_message_at:
      w.last_message_at instanceof Date
        ? w.last_message_at.toISOString()
        : w.last_message_at ?? null,
  };
}
