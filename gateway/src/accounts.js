// Account registry — owns the Session instances and the account lifecycle
// (003 multi-Luna). The DB (whatsapp_accounts) is the source of truth; this
// module keeps the live sessions in sync with it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import {
  listAccounts, getAccount, insertAccount, updateAccount,
} from './db.js';
import { Session } from './session.js';
import { verify } from './hmac.js';

const sessions = new Map(); // account_id -> Session

// luna-service passes agent slugs; keep ids path- and header-safe (they name
// auth dirs on disk and ride in the x-wa-account header).
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validAccountId(id) {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id);
}

export function getSession(accountId) {
  return sessions.get(accountId) ?? null;
}

export function allSessions() {
  return [...sessions.values()];
}

// Pre-003 the single session kept its auth files flat in <authDir>/. Move them
// into <authDir>/default/ once, so the linked number survives without a rescan.
// One-way: rollback needs WA_AUTH_DIR=<authDir>/default (noted in the plan).
export function migrateFlatAuthDir() {
  const root = config.authDir;
  const legacyCreds = path.join(root, 'creds.json');
  const target = path.join(root, config.account);
  if (!fs.existsSync(legacyCreds) || fs.existsSync(target)) return false;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.renameSync(path.join(root, entry.name), path.join(target, entry.name));
    }
  }
  console.log(`[accounts] moved flat auth files into ${target}/`);
  return true;
}

async function startSessionFor(row) {
  const session = new Session(row);
  sessions.set(row.account_id, session);
  try {
    await session.start();
  } catch (e) {
    console.error('[accounts] start %s failed: %s', row.account_id, e.message);
    session.status = 'disconnected';
    session.scheduleReconnect();
  }
  return session;
}

// Boot: start a session for every enabled account this gateway owns.
export async function loadAll() {
  migrateFlatAuthDir();
  const rows = await listAccounts();
  for (const row of rows) {
    await startSessionFor(row);
  }
  console.log(`[accounts] ${rows.length} account(s) loaded (gateway ${config.gatewayId})`);
  return rows.length;
}

// POST /accounts — idempotent create. Returns {row, secret, created}: the
// secret is returned to the caller (control plane) on every call; it is never
// exposed on any read path.
export async function createAccount({ account_id, inbound_url, daily_cap }) {
  if (!validAccountId(account_id)) {
    throw Object.assign(new Error('invalid account_id'), { status: 400 });
  }
  const existing = await getAccount(account_id);
  if (existing) {
    if (!existing.enabled) {
      // Re-enable a previously deleted slot (fresh link lifecycle).
      await updateAccount(account_id, {
        enabled: true, status: 'created',
        ...(inbound_url !== undefined ? { inbound_url } : {}),
        ...(daily_cap !== undefined ? { daily_cap } : {}),
      });
    } else if (inbound_url !== undefined && inbound_url !== existing.inbound_url) {
      await updateAccount(account_id, { inbound_url });
    }
    const row = await getAccount(account_id);
    let session = sessions.get(account_id);
    if (session) {
      session.updateRoute({ inbound_url: row.inbound_url, daily_cap: row.daily_cap });
    } else {
      session = await startSessionFor(row);
    }
    return { row, secret: row.secret, created: false };
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const row = await insertAccount({ account_id, secret, inbound_url, daily_cap });
  await startSessionFor(row);
  return { row, secret, created: true };
}

// PATCH /accounts/{id}. Returns the new secret only when rotated.
export async function patchAccount(accountId, { inbound_url, daily_cap, rotate_secret }) {
  const existing = await getAccount(accountId);
  if (!existing || !existing.enabled) return null;
  const patch = {};
  if (inbound_url !== undefined) patch.inbound_url = inbound_url;
  if (daily_cap !== undefined) patch.daily_cap = daily_cap;
  let newSecret = null;
  if (rotate_secret) {
    newSecret = crypto.randomBytes(32).toString('hex');
    patch.secret = newSecret;
  }
  const row = Object.keys(patch).length
    ? await updateAccount(accountId, patch)
    : existing;
  sessions.get(accountId)?.updateRoute({
    inbound_url: row.inbound_url, secret: row.secret, daily_cap: row.daily_cap,
  });
  return { row, secret: newSecret };
}

// DELETE /accounts/{id} — logout, stop, wipe auth files, disable the row.
// Message capture history is never deleted.
export async function deleteAccount(accountId) {
  const existing = await getAccount(accountId);
  if (!existing) return false;
  const session = sessions.get(accountId);
  if (session) {
    await session.stop({ logout: true });
    sessions.delete(accountId);
  }
  const dir = path.join(config.authDir, accountId);
  // accountId is regex-validated, so the path cannot escape authDir.
  fs.rmSync(dir, { recursive: true, force: true });
  await updateAccount(accountId, { enabled: false, status: 'disabled', self_jid: null });
  return true;
}

// ---------------------------------------------------------------------------
// request → account resolution (pure core, testable without sessions)
// ---------------------------------------------------------------------------

// candidates: [{id, secret}]. legacy: {secret, accountId} or null.
// Returns the matching account id, or null.
export function resolveAccountId({ headerAccount, rawBody, ts, sig }, candidates, legacy) {
  if (headerAccount) {
    const hit = candidates.find((c) => c.id === headerAccount);
    if (hit && verify(hit.secret, rawBody, ts, sig)) return hit.id;
    return null; // explicit account claim must verify against THAT secret only
  }
  for (const c of candidates) {
    if (verify(c.secret, rawBody, ts, sig)) return c.id;
  }
  if (legacy?.secret && verify(legacy.secret, rawBody, ts, sig)) {
    return legacy.accountId;
  }
  return null;
}

// Express-facing wrapper: resolve the sending session for a signed request.
export function resolveSession(req) {
  const ts = req.header('x-wa-timestamp');
  const sig = req.header('x-wa-signature');
  const headerAccount = req.header('x-wa-account') || null;
  const candidates = allSessions().map((s) => ({ id: s.accountId, secret: s.secret }));
  const legacy = config.sharedSecret
    ? { secret: config.sharedSecret, accountId: config.account }
    : null;
  const id = resolveAccountId(
    { headerAccount, rawBody: req.rawBody || '', ts, sig },
    candidates, legacy,
  );
  return id ? sessions.get(id) ?? null : null;
}

export async function stopAll() {
  for (const s of sessions.values()) {
    await s.stop();
  }
  sessions.clear();
}
