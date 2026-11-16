// Owner jobs, shared by the command line (admin.ts) and the Sterling Admin window (admin-ui.ts).
// They run on the owner's PC through Wrangler, signed in to Cloudflare with 2FA. There is no admin
// route on the server: these talk to D1 directly with fixed SQL. Nothing here takes free text.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchUsage, fetchHealth, percentages, FREE_LIMITS } from "../src/usage";

export const ID = /^[0-9a-f]{16}$/;

export class AdminError extends Error {}

function dbName(): string {
  if (process.env.SQS_ADMIN_TEST_CONFIG) return "test";
  if (!existsSync("wrangler.toml")) {
    throw new AdminError("No wrangler.toml here. Copy wrangler.example.toml to wrangler.toml and fill it in first.");
  }
  const m = /database_name\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"));
  return m ? m[1] : "sterling-quest-sync";
}

/** The owner's tokens live outside the repo (and outside any synced folder): ~/.sterling-admin/admin.env. */
export function adminEnvPath(): string {
  return process.env.SQS_ADMIN_ENV || join(homedir(), ".sterling-admin", "admin.env");
}

let envLoaded = false;
export function loadAdminEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  for (const path of [adminEnvPath(), ".admin.env"]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
}

/** How Wrangler signs in: the database-only token when it's set up, otherwise your `wrangler login`. */
export function signIn(): "token" | "login" {
  loadAdminEnv();
  return process.env.CF_D1_TOKEN && process.env.CF_ACCOUNT_ID ? "token" : "login";
}

function wranglerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  // Wrangler reads CF_* as old spellings of its own settings and warns about them, so it never sees ours.
  for (const k of ["CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_D1_TOKEN"]) delete env[k];
  if (signIn() === "token") {
    env.CLOUDFLARE_API_TOKEN = process.env.CF_D1_TOKEN;
    env.CLOUDFLARE_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
  }
  return env;
}

/** Where the SQL runs: the live database, or a local test copy when SQS_ADMIN_TEST_CONFIG is set. */
function target(exporting = false): string[] {
  const cfg = process.env.SQS_ADMIN_TEST_CONFIG;
  if (cfg) return exporting ? ["-c", cfg, "--local"] : ["-c", cfg, "--local", "--persist-to", process.env.SQS_ADMIN_TEST_PERSIST || ".wrangler/state"];
  return ["--remote"];
}

/** Wrangler's --json answer, even when it prints a banner or notes around it. undefined if there is none. */
function parseWranglerJson(raw: string): any {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, "");
  try { return JSON.parse(text); } catch { /* look for the JSON part */ }
  for (let i = text.indexOf("["); i >= 0; i = text.indexOf("[", i + 1)) {
    const end = text.lastIndexOf("]");
    if (end <= i) break;
    try { return JSON.parse(text.slice(i, end + 1)); } catch { /* try the next bracket */ }
  }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* none */ } }
  return undefined;
}

/** The line of Wrangler's output that says what went wrong, without colour codes. */
function wranglerError(text: string): string {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Warnings are never the reason it failed: skip them and everything that belongs to them.
  const useful = lines.filter((l) => !/^▲|\[WARNING\]|deprecated|Logs were written|^🪵|^-+$/i.test(l));
  const i = useful.findIndex((l) => /ERROR|✘/.test(l));
  const pick = i >= 0 ? useful.slice(i, i + 3) : useful.slice(-2);
  return (pick.join(" ").replace(/✘\s*\[ERROR\]\s*/g, "") || "Wrangler failed.").slice(0, 400);
}

export async function d1(sql: string): Promise<any[]> {
  return (await d1Sets(sql)).flat();
}

function wranglerName(): string {
  if (process.env.SQS_ADMIN_TEST_CONFIG) return "sterling-quest-sync-test";
  const m = existsSync("wrangler.toml") ? /^name\s*=\s*"([^"]+)"/m.exec(readFileSync("wrangler.toml", "utf8")) : null;
  return m ? m[1] : "sterling-quest-sync";
}

function serverUrl(): string | null {
  if (process.env.SQS_ADMIN_TEST_URL) return process.env.SQS_ADMIN_TEST_URL;
  if (!existsSync("wrangler.toml")) return null;
  const m = /pattern\s*=\s*"([^"/*]+)"/.exec(readFileSync("wrangler.toml", "utf8"));
  return m ? "https://" + m[1] : null;
}

/** Runs fixed SQL and returns one result list per statement. SQL goes through a temp file, never the command line. */
export function d1Sets(sql: string): Promise<any[][]> {
  const dir = mkdtempSync(join(tmpdir(), "sqs-admin-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["wrangler", "d1", "execute", dbName(), ...target(), "--json", "--file", file], {
      shell: process.platform === "win32",
      env: wranglerEnv(),
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      rmSync(dir, { recursive: true, force: true });
      reject(new AdminError("Couldn't start Wrangler: " + e.message));
    });
    p.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (code !== 0) {
        const text = (err || out).trim();
        const hint = /login|auth|not authorized|10000/i.test(text)
          ? signIn() === "token"
            ? " The database token may have expired or been deleted. Run set-admin-token.cmd again."
            : " Run `npx wrangler login` in this folder, or set up the database-only token with set-admin-token.cmd."
          : "";
        return reject(new AdminError(wranglerError(text) + hint));
      }
      const parsed = parseWranglerJson(out);
      if (parsed === undefined) {
        const hint = out.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).join(" ").slice(0, 200);
        return reject(new AdminError("Couldn't read Wrangler's answer" + (hint ? ": " + hint : ".")));
      }
      const sets = Array.isArray(parsed) ? parsed : [parsed];
      if (sets.some((x: any) => x && x.success === false)) {
        return reject(new AdminError("The database refused the query: " + JSON.stringify(sets.find((x: any) => x?.success === false)?.errors ?? "").slice(0, 200)));
      }
      resolve(sets.map((x: any) => x?.results ?? []));
    });
  });
}

export interface AccountRow {
  account: string;
  characters: string;
  pairings: number;
  pcs: number;
  created: number;
  last_seen: number;
  banned: boolean;
}

export async function accounts(): Promise<AccountRow[]> {
  const rows = await d1(`
    SELECT a.id, a.created_at, a.last_seen, a.banned,
      (SELECT COUNT(*) FROM keys k WHERE k.account_id = a.id) AS pcs,
      (SELECT GROUP_CONCAT(c.name, ', ') FROM characters c WHERE c.account_id = a.id) AS characters,
      (SELECT COUNT(*) FROM pairings p WHERE p.ended_at IS NULL AND (p.a_account = a.id OR p.b_account = a.id)) AS pairings
    FROM accounts a ORDER BY a.last_seen DESC LIMIT 200;`);
  return rows.map((r) => ({
    account: String(r.id),
    characters: String(r.characters || ""),
    pairings: Number(r.pairings),
    pcs: Number(r.pcs),
    created: Number(r.created_at),
    last_seen: Number(r.last_seen),
    banned: !!r.banned,
  }));
}

export async function ban(id: string, on: boolean): Promise<string> {
  if (!ID.test(id)) throw new AdminError("Account ids are 16 characters, 0-9 and a-f.");
  const t = Math.floor(Date.now() / 1000);
  if (on) {
    await d1(`
      UPDATE accounts SET banned = 1 WHERE id = '${id}';
      UPDATE pairings SET ended_at = ${t}, ended_reason = 'banned' WHERE ended_at IS NULL AND (a_account = '${id}' OR b_account = '${id}');
      DELETE FROM slots WHERE account_id = '${id}';
      DELETE FROM pair_codes WHERE account_id = '${id}';
      DELETE FROM link_codes WHERE account_id = '${id}';
      DELETE FROM invites WHERE account_id = '${id}';`);
    return `Banned ${id}. Its pairings are ended and its data and codes removed.`;
  }
  await d1(`UPDATE accounts SET banned = 0 WHERE id = '${id}';`);
  return `Unbanned ${id}. Old pairings stay ended; they can pair again with new codes.`;
}

export async function signups(mode: string): Promise<string> {
  if (mode !== "on" && mode !== "off") throw new AdminError("Sign-ups can only be on or off.");
  await d1(`UPDATE settings SET v = '${mode === "on" ? "open" : "invite"}' WHERE k = 'signups';`);
  return mode === "on" ? "Sign-ups are open." : "Sign-ups are closed. New accounts now need an invite from an existing user.";
}

export interface Stats {
  db: { accounts: number; active_today: number; pairings: number; slots: number; packet_bytes: number; signups: string };
  usage: null | {
    date: string;
    rows: { name: string; used: number; limit: number; percent: number }[];
  };
  usage_note: string | null;
}

export async function stats(): Promise<Stats> {
  const [c] = await d1(`
    SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM accounts WHERE last_seen > strftime('%s','now') - 86400) AS active_today,
      (SELECT COUNT(*) FROM pairings WHERE ended_at IS NULL) AS pairings,
      (SELECT COUNT(*) FROM slots) AS slots,
      (SELECT COALESCE(SUM(LENGTH(packet)), 0) FROM slots) AS packet_bytes,
      (SELECT v FROM settings WHERE k = 'signups') AS signups;`);
  const db = {
    accounts: Number(c.accounts),
    active_today: Number(c.active_today),
    pairings: Number(c.pairings),
    slots: Number(c.slots),
    packet_bytes: Number(c.packet_bytes),
    signups: String(c.signups),
  };
  loadAdminEnv();
  const token = process.env.CF_API_TOKEN;
  const acct = process.env.CF_ACCOUNT_ID;
  if (!token || !acct) {
    return { db, usage: null, usage_note: "For today's Cloudflare usage, put CF_API_TOKEN and CF_ACCOUNT_ID in .admin.env (git-ignored)." };
  }
  try {
    const u = await fetchUsage(acct, token);
    const p = percentages(u);
    return {
      db,
      usage: {
        date: u.date,
        rows: [
          { name: "Requests", used: u.requests, limit: FREE_LIMITS.requests, percent: p.requests },
          { name: "D1 rows read", used: u.rowsRead, limit: FREE_LIMITS.rowsRead, percent: p.rowsRead },
          { name: "D1 rows written", used: u.rowsWritten, limit: FREE_LIMITS.rowsWritten, percent: p.rowsWritten },
        ],
      },
      usage_note: null,
    };
  } catch (e) {
    return { db, usage: null, usage_note: "Couldn't load today's usage: " + (e as Error).message };
  }
}

// ---------------------------------------------------------------- overview (one database call)

export interface Warning { text: string; fix: string }

export interface Overview {
  server: { ok: boolean; ms: number | null; api: number | null; min_app: string | null; signups: string | null; error: string | null; url: string | null };
  db: Stats["db"] & { new_24h: number; new_7d: number; unpaired_new: number };
  cron: { last: number | null; cleanup_last: number | null; last_alert: string | null };
  cleanup_preview: { unpaired_accounts: number; idle_accounts: number; old_copies: number; old_pairings: number; expired_codes: number };
  usage: Stats["usage"];
  health: null | { requests: number; errors: number; error_pct: number; cpuP50: number; cpuP99: number };
  notes: string[];
  warnings: Warning[];
}

async function serverCheck(): Promise<Overview["server"]> {
  const url = serverUrl();
  if (!url) return { ok: false, ms: null, api: null, min_app: null, signups: null, error: "No server address in wrangler.toml.", url };
  const t0 = Date.now();
  try {
    const r = await fetch(url + "/v1/meta", { signal: AbortSignal.timeout(8000) });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ms, api: null, min_app: null, signups: null, error: "Server answered " + r.status, url };
    const m = (await r.json()) as any;
    return { ok: true, ms, api: Number(m.api), min_app: String(m.min_app), signups: String(m.signups), error: null, url };
  } catch (e) {
    return { ok: false, ms: null, api: null, min_app: null, signups: null, error: "Can't reach the server: " + (e as Error).message, url };
  }
}

export async function overview(): Promise<Overview> {
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  const [srv, sets] = await Promise.all([
    serverCheck(),
    d1Sets(`
      SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM accounts WHERE last_seen > ${now - DAY}) AS active_today,
        (SELECT COUNT(*) FROM pairings WHERE ended_at IS NULL) AS pairings,
        (SELECT COUNT(*) FROM slots) AS slots,
        (SELECT COALESCE(SUM(LENGTH(packet)), 0) FROM slots) AS packet_bytes,
        (SELECT v FROM settings WHERE k = 'signups') AS signups,
        (SELECT COUNT(*) FROM accounts WHERE created_at > ${now - DAY}) AS new_24h,
        (SELECT COUNT(*) FROM accounts WHERE created_at > ${now - 7 * DAY}) AS new_7d,
        (SELECT COUNT(*) FROM accounts WHERE ever_paired = 0) AS unpaired_new;
      SELECT (SELECT v FROM settings WHERE k = 'cron:last') AS cron_last,
        (SELECT v FROM settings WHERE k = 'cleanup:last') AS cleanup_last,
        (SELECT MAX(k) FROM settings WHERE k LIKE 'alerted:%') AS last_alert;
      SELECT (SELECT COUNT(*) FROM accounts WHERE ever_paired = 0 AND created_at < ${now - 7 * DAY}) AS unpaired_accounts,
        (SELECT COUNT(*) FROM accounts WHERE last_seen < ${now - 365 * DAY}) AS idle_accounts,
        (SELECT COUNT(*) FROM slots WHERE updated_at < ${now - 30 * DAY}) AS old_copies,
        (SELECT COUNT(*) FROM pairings WHERE ended_at IS NOT NULL AND ended_at < ${now - 30 * DAY}) AS old_pairings,
        ((SELECT COUNT(*) FROM pair_codes WHERE expires_at < ${now}) + (SELECT COUNT(*) FROM link_codes WHERE expires_at < ${now})
          + (SELECT COUNT(*) FROM invites WHERE expires_at < ${now})) AS expired_codes;`),
  ]);
  const [c] = sets[0];
  const [k] = sets[1];
  const [p] = sets[2];
  const out: Overview = {
    server: srv,
    db: {
      accounts: Number(c.accounts), active_today: Number(c.active_today), pairings: Number(c.pairings), slots: Number(c.slots),
      packet_bytes: Number(c.packet_bytes), signups: String(c.signups), new_24h: Number(c.new_24h), new_7d: Number(c.new_7d),
      unpaired_new: Number(c.unpaired_new),
    },
    cron: {
      last: k.cron_last ? Number(k.cron_last) : null,
      cleanup_last: k.cleanup_last ? Number(k.cleanup_last) : null,
      last_alert: k.last_alert ? String(k.last_alert).slice("alerted:".length) : null,
    },
    cleanup_preview: {
      unpaired_accounts: Number(p.unpaired_accounts), idle_accounts: Number(p.idle_accounts), old_copies: Number(p.old_copies),
      old_pairings: Number(p.old_pairings), expired_codes: Number(p.expired_codes),
    },
    usage: null,
    health: null,
    notes: [],
    warnings: [],
  };

  loadAdminEnv();
  const token = process.env.CF_API_TOKEN || process.env.CF_D1_TOKEN;
  const acct = process.env.CF_ACCOUNT_ID;
  if (token && acct) {
    const [u, h] = await Promise.allSettled([fetchUsage(acct, token), fetchHealth(acct, token, wranglerName())]);
    if (u.status === "fulfilled") {
      const pc = percentages(u.value);
      out.usage = {
        date: u.value.date,
        rows: [
          { name: "Requests", used: u.value.requests, limit: FREE_LIMITS.requests, percent: pc.requests },
          { name: "D1 rows read", used: u.value.rowsRead, limit: FREE_LIMITS.rowsRead, percent: pc.rowsRead },
          { name: "D1 rows written", used: u.value.rowsWritten, limit: FREE_LIMITS.rowsWritten, percent: pc.rowsWritten },
        ],
      };
    } else out.notes.push("Couldn't load today's usage: " + (u.reason as Error).message);
    if (h.status === "fulfilled") {
      const v = h.value;
      out.health = { ...v, error_pct: v.requests ? (v.errors / v.requests) * 100 : 0 };
    } else out.notes.push("Couldn't load errors and CPU time: " + (h.reason as Error).message);
  } else {
    out.notes.push("For today's usage, errors and CPU time, set up the admin token: double-click set-admin-token.cmd in this folder.");
  }

  // Warnings, each with what to do. Gold in the window.
  const w = out.warnings;
  if (!srv.ok) w.push({ text: srv.error || "The server isn't answering.", fix: "Check the Worker in the Cloudflare dashboard, then deploy again with deploy.cmd." });
  if (out.cron.last === null) w.push({ text: "The hourly job has never recorded a run.", fix: "Normal right after this update is deployed. If it stays empty for 2 hours, check Triggers on the Worker in Cloudflare." });
  else if (now - out.cron.last > 2 * 3600) w.push({ text: "The hourly job hasn't run for " + Math.round((now - out.cron.last) / 3600) + " hours, so no usage alert emails.", fix: "Check Triggers on the Worker in the Cloudflare dashboard." });
  if (out.cron.cleanup_last !== null && now - out.cron.cleanup_last > 2 * DAY) w.push({ text: "The daily cleanup hasn't run for " + Math.round((now - out.cron.cleanup_last) / DAY) + " days.", fix: "Check Triggers on the Worker in the Cloudflare dashboard." });
  for (const r of out.usage?.rows ?? []) if (r.percent >= 50) w.push({ text: `${r.name} is at ${r.percent.toFixed(0)}% of today's free limit.`, fix: "It resets at 00:00 UTC. If it keeps happening, turn on Workers Paid ($5) in Cloudflare." });
  if (out.health) {
    if (out.health.cpuP99 >= 7) w.push({ text: `Slowest requests use ${out.health.cpuP99.toFixed(1)} ms of CPU (free limit 10 ms).`, fix: "Requests over 10 ms fail on the free plan. Tell Claude, or turn on Workers Paid." });
    if (out.health.requests >= 50 && out.health.error_pct >= 5) w.push({ text: `${out.health.error_pct.toFixed(0)}% of today's requests ended in a server error.`, fix: "Look at the Worker's logs in the Cloudflare dashboard and tell Claude what they say." });
  }
  if (out.db.new_24h >= 20 && out.db.signups === "open") w.push({ text: `${out.db.new_24h} new accounts in the last 24 hours.`, fix: "If you don't know where they came from, close sign-ups on the Sign-ups page." });
  return out;
}

// ---------------------------------------------------------------- backup

/** Backups hold everyone's data, so they live outside this folder (and outside the Claude folder). */
export function backupDir(): string {
  return process.env.SQS_ADMIN_BACKUP_DIR || join(homedir(), "Sterling Admin Backups");
}

export function backup(): Promise<{ file: string; dir: string }> {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(dir, `sterling-quest-sync-${stamp}.sql`);
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["wrangler", "d1", "export", dbName(), ...target(true), "--output", file], {
      shell: process.platform === "win32",
      env: wranglerEnv(),
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.stdout.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new AdminError("Couldn't start Wrangler: " + e.message)));
    p.on("close", (code) => {
      if (code !== 0 || !existsSync(file)) return reject(new AdminError("Backup failed: " + wranglerError(err)));
      resolve({ file, dir });
    });
  });
}
