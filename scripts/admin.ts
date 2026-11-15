// Owner jobs, run on the owner's PC through Wrangler (signed in to Cloudflare with 2FA).
// There is no admin route on the server: these talk to D1 directly with fixed SQL.
//
//   npm run admin accounts          list accounts, newest activity first
//   npm run admin ban <id>          lock an account out and end its pairings
//   npm run admin unban <id>
//   npm run admin signups on|off    on = open sign-up, off = invite-only
//   npm run admin stats             counts, plus today's Cloudflare usage if a token is set

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsage, percentages, FREE_LIMITS } from "../src/usage";

const ID = /^[0-9a-f]{16}$/;

function dbName(): string {
  if (!existsSync("wrangler.toml")) {
    console.error("No wrangler.toml here. Copy wrangler.example.toml to wrangler.toml and fill it in first.");
    process.exit(1);
  }
  const m = /database_name\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"));
  return m ? m[1] : "sterling-quest-sync";
}

function loadAdminEnv(): void {
  if (!existsSync(".admin.env")) return;
  for (const line of readFileSync(".admin.env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

/** Runs fixed SQL against the remote database. SQL goes through a temp file, never the command line. */
function d1(sql: string): any[] {
  const dir = mkdtempSync(join(tmpdir(), "sqs-admin-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql);
  try {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", dbName(), "--remote", "--json", "--file", file], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) {
      console.error((r.stderr || r.stdout || "").trim());
      process.exit(1);
    }
    const out = JSON.parse(r.stdout);
    const sets = Array.isArray(out) ? out : [out];
    return sets.flatMap((s: any) => s.results ?? []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const day = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "");

function accounts(): void {
  const rows = d1(`
    SELECT a.id, a.created_at, a.last_seen, a.banned,
      (SELECT COUNT(*) FROM keys k WHERE k.account_id = a.id) AS pcs,
      (SELECT GROUP_CONCAT(c.name, ', ') FROM characters c WHERE c.account_id = a.id) AS characters,
      (SELECT COUNT(*) FROM pairings p WHERE p.ended_at IS NULL AND (p.a_account = a.id OR p.b_account = a.id)) AS pairings
    FROM accounts a ORDER BY a.last_seen DESC LIMIT 200;`);
  console.table(rows.map((r) => ({
    account: r.id,
    characters: (r.characters || "").slice(0, 40),
    pairings: r.pairings,
    pcs: r.pcs,
    created: day(r.created_at),
    last_seen: day(r.last_seen),
    banned: r.banned ? "BANNED" : "",
  })));
}

function ban(id: string, on: boolean): void {
  if (!ID.test(id)) {
    console.error("Account ids are 16 characters, 0-9 and a-f.");
    process.exit(1);
  }
  const t = Math.floor(Date.now() / 1000);
  if (on) {
    d1(`
      UPDATE accounts SET banned = 1 WHERE id = '${id}';
      UPDATE pairings SET ended_at = ${t}, ended_reason = 'banned' WHERE ended_at IS NULL AND (a_account = '${id}' OR b_account = '${id}');
      DELETE FROM slots WHERE account_id = '${id}';
      DELETE FROM pair_codes WHERE account_id = '${id}';
      DELETE FROM link_codes WHERE account_id = '${id}';
      DELETE FROM invites WHERE account_id = '${id}';`);
    console.log(`Banned ${id}. Its pairings are ended and its data and codes removed.`);
  } else {
    d1(`UPDATE accounts SET banned = 0 WHERE id = '${id}';`);
    console.log(`Unbanned ${id}. Old pairings stay ended; they can pair again with new codes.`);
  }
}

function signups(mode: string): void {
  if (mode !== "on" && mode !== "off") {
    console.error("Use: npm run admin signups on   (or off)");
    process.exit(1);
  }
  d1(`UPDATE settings SET v = '${mode === "on" ? "open" : "invite"}' WHERE k = 'signups';`);
  console.log(mode === "on" ? "Sign-ups are open." : "Sign-ups are closed. New accounts now need an invite from an existing user.");
}

async function stats(): Promise<void> {
  const [c] = d1(`
    SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM accounts WHERE last_seen > strftime('%s','now') - 86400) AS active_today,
      (SELECT COUNT(*) FROM pairings WHERE ended_at IS NULL) AS pairings,
      (SELECT COUNT(*) FROM slots) AS slots,
      (SELECT COALESCE(SUM(LENGTH(packet)), 0) FROM slots) AS packet_bytes,
      (SELECT v FROM settings WHERE k = 'signups') AS signups;`);
  console.log("Database");
  console.table(c);
  loadAdminEnv();
  const token = process.env.CF_API_TOKEN;
  const acct = process.env.CF_ACCOUNT_ID;
  if (!token || !acct) {
    console.log("For today's usage, put CF_API_TOKEN and CF_ACCOUNT_ID in .admin.env (git-ignored).");
    return;
  }
  const u = await fetchUsage(acct, token);
  const p = percentages(u);
  console.log(`Cloudflare usage today (${u.date}, UTC, whole account)`);
  console.table({
    requests: { used: u.requests, limit: FREE_LIMITS.requests, percent: p.requests.toFixed(1) },
    "D1 rows read": { used: u.rowsRead, limit: FREE_LIMITS.rowsRead, percent: p.rowsRead.toFixed(1) },
    "D1 rows written": { used: u.rowsWritten, limit: FREE_LIMITS.rowsWritten, percent: p.rowsWritten.toFixed(1) },
  });
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "accounts": accounts(); break;
  case "ban": ban(arg ?? "", true); break;
  case "unban": ban(arg ?? "", false); break;
  case "signups": signups(arg ?? ""); break;
  case "stats": await stats(); break;
  default:
    console.log("Commands: accounts | ban <id> | unban <id> | signups on|off | stats");
}
