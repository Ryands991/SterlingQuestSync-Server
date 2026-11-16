// Sterling Quest Sync server: one Worker, one D1 database.
// Identity comes only from the bearer key. Data only flows through an active pairing.

import {
  API_VERSION, MIN_APP_VERSION, DAY, PAIR_CODE_TTL, LINK_CODE_TTL, INVITE_TTL,
  MAX_PARTNERS, MAX_CHARACTERS, MAX_KEYS, MAX_PACKET, INBOX_LIMIT, MAX_UPLOADS_PER_DAY, MAX_CLOCK_AHEAD, pathPart,
  HttpError, json, fail, now, randomHex, randomCode, groupCode, normalizeCode, sha256,
  RE_NAME, RE_REALM, RE_PACKET, guid, label, id, readJson, bearer,
} from "./util";
import { scheduled } from "./cron";

export interface Env {
  DB: D1Database;
  RL_SIGNUP?: RateLimit;   // per IP: account creation, recovery, link redeem
  RL_CODES?: RateLimit;    // per account and per IP: code redeem and peek
  RL_API?: RateLimit;      // per key: everything else
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_TO?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  USAGE_ALERT_PCT?: string;
}

interface Auth {
  account: string;
  keyHash: string;
  keyId: string;
}

// ---------------------------------------------------------------- helpers

async function limit(rl: RateLimit | undefined, key: string): Promise<void> {
  if (!rl) return;
  const { success } = await rl.limit({ key });
  if (!success) fail(429, "rate_limited");
}

function ip(req: Request): string {
  return req.headers.get("cf-connecting-ip") || "unknown";
}

async function authenticate(req: Request, env: Env): Promise<Auth> {
  const key = bearer(req);
  // Per address first, so a flood of made-up keys is stopped before it costs database reads.
  await limit(env.RL_API, "ip:" + ip(req));
  const hash = await sha256(key);
  const row = await env.DB.prepare(
    "SELECT k.id AS key_id, k.last_seen AS seen, a.id AS account, a.banned AS banned " +
      "FROM keys k JOIN accounts a ON a.id = k.account_id WHERE k.hash = ?1",
  ).bind(hash).first<{ key_id: string; seen: number; account: string; banned: number }>();
  if (!row) fail(401, "unknown_key");
  if (row.banned) fail(403, "banned");
  await limit(env.RL_API, "k:" + hash.slice(0, 32));
  const t = now();
  // Writes are the scarce resource on the free plan, so "last seen" moves at most once a day.
  if (row.seen < t - DAY) {
    await env.DB.batch([
      env.DB.prepare("UPDATE keys SET last_seen = ?1 WHERE hash = ?2").bind(t, hash),
      env.DB.prepare("UPDATE accounts SET last_seen = ?1 WHERE id = ?2").bind(t, row.account),
    ]);
  }
  return { account: row.account, keyHash: hash, keyId: row.key_id };
}

async function signups(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'signups'").first<{ v: string }>();
  return r?.v === "invite" ? "invite" : "open";
}

async function newRecovery(): Promise<{ code: string; hash: string }> {
  const raw = randomCode(20);
  return { code: "SQS-" + groupCode(raw), hash: await sha256("recovery:" + raw) };
}

async function myCharacter(env: Env, account: string, g: string) {
  const c = await env.DB.prepare(
    "SELECT guid, name, realm FROM characters WHERE account_id = ?1 AND guid = ?2",
  ).bind(account, g).first<{ guid: string; name: string; realm: string }>();
  if (!c) fail(404, "character_not_listed");
  return c;
}

async function activePartners(env: Env, account: string, g: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pairings WHERE ended_at IS NULL AND " +
      "((a_account = ?1 AND a_guid = ?2) OR (b_account = ?1 AND b_guid = ?2))",
  ).bind(account, g).first<{ n: number }>();
  return r?.n ?? 0;
}

// Adds a key row for a PC. Shared by sign-up, link redeem and recovery.
async function insertKeyStmt(env: Env, account: string, key: string, lbl: string, t: number) {
  const hash = await sha256(key);
  const taken = await env.DB.prepare("SELECT 1 FROM keys WHERE hash = ?1").bind(hash).first();
  if (taken) fail(409, "key_exists");
  const kid = randomHex(8);
  return {
    kid,
    stmt: env.DB.prepare(
      "INSERT INTO keys (hash, id, account_id, label, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    ).bind(hash, kid, account, lbl, t),
  };
}

async function keyCount(env: Env, account: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM keys WHERE account_id = ?1").bind(account).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------- accounts

async function createAccount(req: Request, env: Env): Promise<Response> {
  await limit(env.RL_SIGNUP, "signup:" + ip(req));
  const key = bearer(req);
  const body = await readJson(req);
  const mode = await signups(env);
  const t = now();
  let invitedBy: string | null = null;
  let inviteHash: string | null = null;
  if (mode === "invite") {
    const code = normalizeCode(body.invite, 12);
    if (!code) fail(403, "invite_required");
    inviteHash = await sha256("invite:" + code);
    const inv = await env.DB.prepare("SELECT account_id FROM invites WHERE hash = ?1 AND expires_at > ?2")
      .bind(inviteHash, t).first<{ account_id: string }>();
    if (!inv) fail(403, "invite_required");
    invitedBy = inv.account_id;
  }
  const account = randomHex(8);
  const rec = await newRecovery();
  const k = await insertKeyStmt(env, account, key, label(body.label), t);
  const stmts = [
    env.DB.prepare(
      "INSERT INTO accounts (id, created_at, last_seen, recovery_hash, invited_by) VALUES (?1, ?2, ?2, ?3, ?4)",
    ).bind(account, t, rec.hash, invitedBy),
    k.stmt,
  ];
  if (inviteHash) {
    // Take the invite first: if two sign-ups race for one invite, only one gets it.
    const took = await env.DB.prepare("DELETE FROM invites WHERE hash = ?1").bind(inviteHash).run();
    if (!took.meta.changes) fail(403, "invite_required");
  }
  await env.DB.batch(stmts);
  return json({ account_id: account, key_id: k.kid, recovery_code: rec.code }, 201);
}

async function getAccount(env: Env, a: Auth): Promise<Response> {
  const acct = await env.DB.prepare("SELECT id, created_at FROM accounts WHERE id = ?1").bind(a.account).first();
  const keys = await env.DB.prepare(
    "SELECT id, label, created_at, last_seen FROM keys WHERE account_id = ?1 ORDER BY created_at",
  ).bind(a.account).all<{ id: string; label: string; created_at: number; last_seen: number }>();
  const chars = await env.DB.prepare(
    "SELECT guid, name, realm FROM characters WHERE account_id = ?1 ORDER BY name",
  ).bind(a.account).all();
  return json({
    account: acct,
    pcs: keys.results.map((k) => ({ ...k, current: k.id === a.keyId })),
    characters: chars.results,
  });
}

/** Removes everything the account owns. Its side of each pairing is scrubbed, and the pairing ended. */
async function deleteAccountData(env: Env, account: string, reason: string): Promise<void> {
  const t = now();
  const n = await env.DB.prepare("UPDATE counters SET v = v + 1 WHERE k = 'deleted' RETURNING v").first<{ v: number }>();
  const tag = "deleted-" + (n?.v ?? 0);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pairings SET ended_at = COALESCE(ended_at, ?2), ended_reason = COALESCE(ended_reason, ?3), " +
        "a_account = '', a_guid = '', a_name = '', a_realm = '', a_key = '' WHERE a_account = ?1",
    ).bind(account, t, reason),
    env.DB.prepare(
      "UPDATE pairings SET ended_at = COALESCE(ended_at, ?2), ended_reason = COALESCE(ended_reason, ?3), " +
        "b_account = '', b_guid = '', b_name = '', b_realm = '', b_key = '' WHERE b_account = ?1",
    ).bind(account, t, reason),
    env.DB.prepare("UPDATE accounts SET invited_by = ?2 WHERE invited_by = ?1").bind(account, tag),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(account),
  ]);
}

async function deleteAccount(env: Env, a: Auth): Promise<Response> {
  await deleteAccountData(env, a.account, "deleted");
  return json({ deleted: true });
}

// ---------------------------------------------------------------- PCs, recovery, invites

async function removeKey(env: Env, a: Auth, kid: string): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM keys WHERE id = ?1 AND account_id = ?2").bind(id(kid), a.account).run();
  if (!r.meta.changes) fail(404, "not_found");
  return json({ removed: true });
}

async function rotateRecovery(env: Env, a: Auth): Promise<Response> {
  const rec = await newRecovery();
  await env.DB.prepare("UPDATE accounts SET recovery_hash = ?1 WHERE id = ?2").bind(rec.hash, a.account).run();
  return json({ recovery_code: rec.code });
}

async function recover(req: Request, env: Env): Promise<Response> {
  await limit(env.RL_SIGNUP, "recover:" + ip(req));
  const key = bearer(req);
  const body = await readJson(req);
  const raw = typeof body.code === "string" ? body.code.toUpperCase().replace(/^SQS-/, "") : null;
  const code = normalizeCode(raw, 20);
  if (!code) fail(404, "not_found");
  const acct = await env.DB.prepare("SELECT id, banned FROM accounts WHERE recovery_hash = ?1")
    .bind(await sha256("recovery:" + code)).first<{ id: string; banned: number }>();
  if (!acct) fail(404, "not_found");
  if (acct.banned) fail(403, "banned");
  if ((await keyCount(env, acct.id)) >= MAX_KEYS) fail(409, "too_many_pcs");
  const t = now();
  const rec = await newRecovery();
  const k = await insertKeyStmt(env, acct.id, key, label(body.label), t);
  await env.DB.batch([
    k.stmt,
    env.DB.prepare("UPDATE accounts SET recovery_hash = ?1, last_seen = ?2 WHERE id = ?3").bind(rec.hash, t, acct.id),
  ]);
  return json({ account_id: acct.id, key_id: k.kid, recovery_code: rec.code });
}

async function makeLinkCode(env: Env, a: Auth): Promise<Response> {
  if ((await keyCount(env, a.account)) >= MAX_KEYS) fail(409, "too_many_pcs");
  const code = randomCode(12);
  const exp = now() + LINK_CODE_TTL;
  await env.DB.prepare("INSERT INTO link_codes (hash, account_id, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256("link:" + code), a.account, exp).run();
  return json({ code: groupCode(code), expires_at: exp }, 201);
}

async function redeemLinkCode(req: Request, env: Env): Promise<Response> {
  await limit(env.RL_SIGNUP, "link:" + ip(req));
  const key = bearer(req);
  const body = await readJson(req);
  const code = normalizeCode(body.code, 12);
  if (!code) fail(404, "not_found");
  const hash = await sha256("link:" + code);
  const t = now();
  const row = await env.DB.prepare("SELECT account_id FROM link_codes WHERE hash = ?1 AND expires_at > ?2")
    .bind(hash, t).first<{ account_id: string }>();
  if (!row) fail(404, "not_found");
  if ((await keyCount(env, row.account_id)) >= MAX_KEYS) fail(409, "too_many_pcs");
  const k = await insertKeyStmt(env, row.account_id, key, label(body.label), t);
  // Take the code first: if two PCs race for one code, only one gets it.
  const took = await env.DB.prepare("DELETE FROM link_codes WHERE hash = ?1").bind(hash).run();
  if (!took.meta.changes) fail(404, "not_found");
  await env.DB.batch([k.stmt]);
  return json({ account_id: row.account_id, key_id: k.kid });
}

async function makeInvite(env: Env, a: Auth): Promise<Response> {
  if ((await signups(env)) !== "invite") fail(409, "signups_open");
  const code = randomCode(12);
  const exp = now() + INVITE_TTL;
  await env.DB.prepare("INSERT INTO invites (hash, account_id, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256("invite:" + code), a.account, exp).run();
  return json({ code: groupCode(code), expires_at: exp }, 201);
}

// ---------------------------------------------------------------- characters

async function putCharacter(req: Request, env: Env, a: Auth, g: string): Promise<Response> {
  g = guid(g);
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const realm = typeof body.realm === "string" ? body.realm.trim() : "";
  if (!RE_NAME.test(name)) fail(400, "bad_name");
  if (!RE_REALM.test(realm)) fail(400, "bad_realm");
  const exists = await env.DB.prepare("SELECT name, realm FROM characters WHERE account_id = ?1 AND guid = ?2")
    .bind(a.account, g).first<{ name: string; realm: string }>();
  if (!exists) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM characters WHERE account_id = ?1").bind(a.account).first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_CHARACTERS) fail(409, "too_many_characters");
  } else if (exists.name === name && exists.realm === realm) {
    return json({ guid: g, name, realm });
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO characters (account_id, guid, name, realm, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT (account_id, guid) DO UPDATE SET name = excluded.name, realm = excluded.realm, updated_at = excluded.updated_at",
    ).bind(a.account, g, name, realm, now()),
    // Keep the names partners see in step with renames.
    env.DB.prepare("UPDATE pairings SET a_name = ?3, a_realm = ?4 WHERE a_account = ?1 AND a_guid = ?2 AND ended_at IS NULL")
      .bind(a.account, g, name, realm),
    env.DB.prepare("UPDATE pairings SET b_name = ?3, b_realm = ?4 WHERE b_account = ?1 AND b_guid = ?2 AND ended_at IS NULL")
      .bind(a.account, g, name, realm),
  ]);
  return json({ guid: g, name, realm });
}

async function deleteCharacter(env: Env, a: Auth, g: string): Promise<Response> {
  g = guid(g);
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE pairings SET ended_at = ?3, ended_reason = 'removed' WHERE ended_at IS NULL AND " +
      "((a_account = ?1 AND a_guid = ?2) OR (b_account = ?1 AND b_guid = ?2))").bind(a.account, g, t),
    env.DB.prepare("DELETE FROM slots WHERE account_id = ?1 AND from_guid = ?2").bind(a.account, g),
    env.DB.prepare("DELETE FROM pair_codes WHERE account_id = ?1 AND guid = ?2").bind(a.account, g),
    env.DB.prepare("DELETE FROM characters WHERE account_id = ?1 AND guid = ?2").bind(a.account, g),
  ]);
  return json({ removed: true });
}

// ---------------------------------------------------------------- pairing

async function makePairCode(req: Request, env: Env, a: Auth): Promise<Response> {
  const body = await readJson(req);
  const g = guid(body.guid);
  await myCharacter(env, a.account, g);
  const t = now();
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pair_codes WHERE account_id = ?1 AND guid = ?2 AND expires_at > ?3",
  ).bind(a.account, g, t).first<{ n: number }>();
  // Open codes can never add up to more partners than the character has room for.
  if ((open?.n ?? 0) + (await activePartners(env, a.account, g)) >= MAX_PARTNERS) fail(409, "partner_limit");
  const code = randomCode(12);
  const cid = randomHex(8);
  await env.DB.prepare("INSERT INTO pair_codes (hash, id, account_id, guid, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(await sha256("pair:" + code), cid, a.account, g, t + PAIR_CODE_TTL).run();
  return json({ id: cid, code: groupCode(code), guid: g, expires_at: t + PAIR_CODE_TTL }, 201);
}

async function listPairCodes(env: Env, a: Auth): Promise<Response> {
  const r = await env.DB.prepare(
    "SELECT id, guid, expires_at FROM pair_codes WHERE account_id = ?1 AND expires_at > ?2 ORDER BY expires_at",
  ).bind(a.account, now()).all();
  return json({ codes: r.results });
}

async function cancelPairCode(env: Env, a: Auth, cid: string): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM pair_codes WHERE id = ?1 AND account_id = ?2").bind(id(cid), a.account).run();
  if (!r.meta.changes) fail(404, "not_found");
  return json({ cancelled: true });
}

interface CodeRow { hash: string; account_id: string; guid: string; name: string; realm: string }

async function lookupPairCode(req: Request, env: Env, a: Auth, body: Record<string, unknown>): Promise<CodeRow> {
  await limit(env.RL_CODES, "codes:a:" + a.account);
  await limit(env.RL_CODES, "codes:ip:" + ip(req));
  const code = normalizeCode(body.code, 12);
  if (!code) fail(404, "not_found");
  const hash = await sha256("pair:" + code);
  const row = await env.DB.prepare(
    "SELECT p.hash, p.account_id, p.guid, c.name, c.realm FROM pair_codes p " +
      "JOIN characters c ON c.account_id = p.account_id AND c.guid = p.guid " +
      "JOIN accounts acc ON acc.id = p.account_id " +
      "WHERE p.hash = ?1 AND p.expires_at > ?2 AND acc.banned = 0",
  ).bind(hash, now()).first<CodeRow>();
  if (!row) fail(404, "not_found");
  if (row.account_id === a.account) fail(409, "own_code");
  return row;
}

/** Another account already paired between these two characters, if any. */
async function existingPair(env: Env, myAccount: string, myGuid: string, theirGuid: string, theirAccount: string) {
  return env.DB.prepare(
    "SELECT id, CASE WHEN a_account = ?1 THEN b_account ELSE a_account END AS other FROM pairings WHERE ended_at IS NULL AND " +
      "((a_account = ?1 AND a_guid = ?2 AND b_guid = ?3) OR (b_account = ?1 AND b_guid = ?2 AND a_guid = ?3))",
  ).bind(myAccount, myGuid, theirGuid).all<{ id: string; other: string }>()
    .then((r) => ({
      same: r.results.find((p) => p.other === theirAccount),
      others: r.results.filter((p) => p.other !== theirAccount),
    }));
}

async function peekPairCode(req: Request, env: Env, a: Auth): Promise<Response> {
  const body = await readJson(req);
  const g = guid(body.guid);
  await myCharacter(env, a.account, g);
  const row = await lookupPairCode(req, env, a, body);
  const ex = await existingPair(env, a.account, g, row.guid, row.account_id);
  return json({
    partner: { guid: row.guid, name: row.name, realm: row.realm },
    already_paired: !!ex.same,
    different_install: ex.others.length > 0,
  });
}

async function redeemPairCode(req: Request, env: Env, a: Auth): Promise<Response> {
  const body = await readJson(req);
  const g = guid(body.guid);
  const me = await myCharacter(env, a.account, g);
  const row = await lookupPairCode(req, env, a, body);
  const ex = await existingPair(env, a.account, g, row.guid, row.account_id);
  if (ex.same) {
    await env.DB.prepare("DELETE FROM pair_codes WHERE hash = ?1").bind(row.hash).run();
    return json({ pairing_id: ex.same.id, already_paired: true });
  }
  if (ex.others.length && body.replace !== true) fail(409, "different_install");
  const replacing = ex.others.length;
  if ((await activePartners(env, a.account, g)) - replacing >= MAX_PARTNERS) fail(409, "partner_limit");
  if ((await activePartners(env, row.account_id, row.guid)) >= MAX_PARTNERS) fail(409, "partner_limit");
  const t = now();
  const pid = randomHex(8);
  // Take the code first: if two accounts race for one code, only one gets the pairing.
  const took = await env.DB.prepare("DELETE FROM pair_codes WHERE hash = ?1").bind(row.hash).run();
  if (!took.meta.changes) fail(404, "not_found");
  const stmts = ex.others.map((p) =>
    env.DB.prepare("UPDATE pairings SET ended_at = ?2, ended_reason = 'replaced' WHERE id = ?1 AND ended_at IS NULL").bind(p.id, t),
  );
  stmts.push(
    env.DB.prepare(
      "INSERT INTO pairings (id, a_account, a_guid, a_name, a_realm, a_key, b_account, b_guid, b_name, b_realm, b_key, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    ).bind(pid, row.account_id, row.guid, row.name, row.realm, randomCode(16), a.account, g, me.name, me.realm, randomCode(16), t),
    env.DB.prepare("UPDATE accounts SET ever_paired = 1 WHERE id IN (?1, ?2)").bind(a.account, row.account_id),
  );
  await env.DB.batch(stmts);
  return json({ pairing_id: pid, replaced: replacing }, 201);
}

async function listPairings(env: Env, a: Auth): Promise<Response> {
  const t = now();
  const r = await env.DB.prepare(
    "SELECT id, created_at, ended_at, ended_reason, " +
      "CASE WHEN a_account = ?1 THEN a_guid ELSE b_guid END AS my_guid, " +
      "CASE WHEN a_account = ?1 THEN b_guid ELSE a_guid END AS partner_guid, " +
      "CASE WHEN a_account = ?1 THEN b_name ELSE a_name END AS partner_name, " +
      "CASE WHEN a_account = ?1 THEN b_realm ELSE a_realm END AS partner_realm, " +
      "CASE WHEN a_account = ?1 THEN a_key ELSE b_key END AS my_key, " +
      "CASE WHEN a_account = ?1 THEN b_key ELSE a_key END AS partner_key " +
      "FROM pairings WHERE (a_account = ?1 OR b_account = ?1) AND (ended_at IS NULL OR ended_at > ?2) ORDER BY created_at",
  ).bind(a.account, t - 30 * DAY).all<Record<string, unknown>>();
  // Keys are only handed out while the pairing is live.
  const pairings = r.results.map((p) =>
    p.ended_at ? { ...p, my_key: null, partner_key: null, status: "ended" } : { ...p, status: "active" },
  );
  return json({ pairings });
}

async function endPairing(env: Env, a: Auth, pid: string): Promise<Response> {
  const r = await env.DB.prepare(
    "UPDATE pairings SET ended_at = ?3, ended_reason = 'removed' WHERE id = ?1 AND ended_at IS NULL AND (a_account = ?2 OR b_account = ?2)",
  ).bind(id(pid), a.account, now()).run();
  if (!r.meta.changes) fail(404, "not_found");
  return json({ ended: true });
}

// ---------------------------------------------------------------- slots and inbox

async function putSlot(req: Request, env: Env, a: Auth, from: string, to: string): Promise<Response> {
  from = guid(from);
  to = guid(to);
  const body = await readJson(req);
  const packet = body.packet;
  const gameTime = body.game_time;
  const proto = body.proto;
  if (typeof packet !== "string" || packet.length === 0) fail(400, "bad_packet");
  if (packet.length > MAX_PACKET) fail(413, "too_large");
  if (!RE_PACKET.test(packet)) fail(400, "bad_packet");
  if (typeof gameTime !== "number" || !Number.isInteger(gameTime) || gameTime < 1_000_000_000 || gameTime > 4_000_000_000) fail(400, "bad_game_time");
  if (typeof proto !== "number" || !Number.isInteger(proto) || proto < 1 || proto > 10_000) fail(400, "bad_proto");
  // A save stamped far in the future would block every later real save for that slot.
  if (gameTime > now() + MAX_CLOCK_AHEAD) fail(400, "bad_game_time");

  if (from === to) {
    await myCharacter(env, a.account, from); // self slot: only your own listed character
  } else {
    // A partner slot needs a live pairing where this account holds the "from" side.
    const p = await env.DB.prepare(
      "SELECT 1 FROM pairings WHERE ended_at IS NULL AND " +
        "((a_account = ?1 AND a_guid = ?2 AND b_guid = ?3) OR (b_account = ?1 AND b_guid = ?2 AND a_guid = ?3))",
    ).bind(a.account, from, to).first();
    if (!p) fail(403, "not_paired");
  }

  const cur = await env.DB.prepare(
    "SELECT game_time, seq, packet = ?4 AS same FROM slots WHERE account_id = ?1 AND from_guid = ?2 AND to_guid = ?3",
  ).bind(a.account, from, to, packet).first<{ game_time: number; seq: number; same: number }>();
  if (cur && cur.game_time > gameTime) return json({ error: "stale", seq: cur.seq, game_time: cur.game_time }, 409);
  if (cur && cur.game_time === gameTime && cur.same) return json({ seq: cur.seq, unchanged: true });

  const t = now();
  // Daily cap per account, so one account can't use up the whole server's daily write allowance.
  const dayKey = "up:" + Math.floor(t / DAY) + ":" + a.account;
  const used = await env.DB.prepare("SELECT v FROM counters WHERE k = ?1").bind(dayKey).first<{ v: number }>();
  if ((used?.v ?? 0) >= MAX_UPLOADS_PER_DAY) fail(429, "daily_limit");
  const res = await env.DB.batch([
    env.DB.prepare("INSERT INTO counters (k, v) VALUES (?1, 1) ON CONFLICT (k) DO UPDATE SET v = v + 1").bind(dayKey),
    env.DB.prepare("UPDATE counters SET v = v + 1 WHERE k = 'seq'"),
    env.DB.prepare(
      "INSERT INTO slots (account_id, from_guid, to_guid, packet, game_time, proto, seq, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT v FROM counters WHERE k = 'seq'), ?7) " +
        "ON CONFLICT (account_id, from_guid, to_guid) DO UPDATE SET packet = excluded.packet, game_time = excluded.game_time, " +
        "proto = excluded.proto, seq = excluded.seq, updated_at = excluded.updated_at WHERE excluded.game_time >= slots.game_time",
    ).bind(a.account, from, to, packet, gameTime, proto, t),
    env.DB.prepare("SELECT seq, game_time FROM slots WHERE account_id = ?1 AND from_guid = ?2 AND to_guid = ?3").bind(a.account, from, to),
  ]);
  const saved = res[3].results[0] as { seq: number; game_time: number };
  if (saved.game_time !== gameTime) return json({ error: "stale", seq: saved.seq, game_time: saved.game_time }, 409);
  return json({ seq: saved.seq }, 201);
}

async function inbox(req: Request, env: Env, a: Auth): Promise<Response> {
  const sinceRaw = new URL(req.url).searchParams.get("since") || "0";
  if (!/^\d{1,15}$/.test(sinceRaw)) fail(400, "bad_since");
  const since = Number(sinceRaw);
  const r = await env.DB.prepare(
    "SELECT s.from_guid, s.to_guid, s.packet, s.game_time, s.proto, s.seq, 'partner' AS kind " +
      "FROM pairings p JOIN slots s ON " +
      "((p.a_account = ?1 AND s.account_id = p.b_account AND s.from_guid = p.b_guid AND s.to_guid = p.a_guid) OR " +
      " (p.b_account = ?1 AND s.account_id = p.a_account AND s.from_guid = p.a_guid AND s.to_guid = p.b_guid)) " +
      "WHERE p.ended_at IS NULL AND s.seq > ?2 " +
      "UNION ALL " +
      "SELECT s.from_guid, s.to_guid, s.packet, s.game_time, s.proto, s.seq, 'self' AS kind " +
      "FROM slots s WHERE s.account_id = ?1 AND s.from_guid = s.to_guid AND s.seq > ?2 " +
      "ORDER BY seq LIMIT ?3",
  ).bind(a.account, since, INBOX_LIMIT + 1).all<{ seq: number }>();
  const more = r.results.length > INBOX_LIMIT;
  const packets = r.results.slice(0, INBOX_LIMIT);
  const last = packets.length ? packets[packets.length - 1].seq : since;
  return json({ packets, next: last, more });
}

// ---------------------------------------------------------------- router

type Handler = (req: Request, env: Env, m: RegExpMatchArray) => Promise<Response>;
type AuthHandler = (req: Request, env: Env, a: Auth, m: RegExpMatchArray) => Promise<Response>;

const open: [string, RegExp, Handler][] = [
  ["GET", /^\/v1\/meta$/, async (_r, env) => json({ api: API_VERSION, min_app: MIN_APP_VERSION, signups: await signups(env) })],
  ["POST", /^\/v1\/accounts$/, (r, env) => createAccount(r, env)],
  ["POST", /^\/v1\/recover$/, (r, env) => recover(r, env)],
  ["POST", /^\/v1\/link-codes\/redeem$/, (r, env) => redeemLinkCode(r, env)],
];

const authed: [string, RegExp, AuthHandler][] = [
  ["GET", /^\/v1\/account$/, (_r, env, a) => getAccount(env, a)],
  ["DELETE", /^\/v1\/account$/, (_r, env, a) => deleteAccount(env, a)],
  ["POST", /^\/v1\/recovery$/, (_r, env, a) => rotateRecovery(env, a)],
  ["DELETE", /^\/v1\/keys\/([^/]+)$/, (_r, env, a, m) => removeKey(env, a, m[1])],
  ["POST", /^\/v1\/link-codes$/, (_r, env, a) => makeLinkCode(env, a)],
  ["POST", /^\/v1\/invites$/, (_r, env, a) => makeInvite(env, a)],
  ["PUT", /^\/v1\/characters\/([^/]+)$/, (r, env, a, m) => putCharacter(r, env, a, pathPart(m[1]))],
  ["DELETE", /^\/v1\/characters\/([^/]+)$/, (_r, env, a, m) => deleteCharacter(env, a, pathPart(m[1]))],
  ["POST", /^\/v1\/pair-codes$/, (r, env, a) => makePairCode(r, env, a)],
  ["GET", /^\/v1\/pair-codes$/, (_r, env, a) => listPairCodes(env, a)],
  ["DELETE", /^\/v1\/pair-codes\/([^/]+)$/, (_r, env, a, m) => cancelPairCode(env, a, m[1])],
  ["POST", /^\/v1\/pair-codes\/peek$/, (r, env, a) => peekPairCode(r, env, a)],
  ["POST", /^\/v1\/pair-codes\/redeem$/, (r, env, a) => redeemPairCode(r, env, a)],
  ["GET", /^\/v1\/pairings$/, (_r, env, a) => listPairings(env, a)],
  ["DELETE", /^\/v1\/pairings\/([^/]+)$/, (_r, env, a, m) => endPairing(env, a, m[1])],
  ["PUT", /^\/v1\/slots\/([^/]+)\/([^/]+)$/, (r, env, a, m) => putSlot(r, env, a, pathPart(m[1]), pathPart(m[2]))],
  ["GET", /^\/v1\/inbox$/, (r, env, a) => inbox(r, env, a)],
];

async function route(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  let pathMatched = false;
  for (const [method, re, h] of open) {
    const m = path.match(re);
    if (!m) continue;
    pathMatched = true;
    if (method === req.method) return h(req, env, m);
  }
  for (const [method, re, h] of authed) {
    const m = path.match(re);
    if (!m) continue;
    pathMatched = true;
    if (method === req.method) return h(req, env, await authenticate(req, env), m);
  }
  return json({ error: pathMatched ? "method_not_allowed" : "not_found" }, pathMatched ? 405 : 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      // Never echo internals. The log line carries no keys, codes or packets.
      console.error("unhandled", e instanceof Error ? e.name + ": " + e.message.slice(0, 200) : "unknown");
      return json({ error: "server_error" }, 500);
    }
  },
  scheduled,
} satisfies ExportedHandler<Env>;
