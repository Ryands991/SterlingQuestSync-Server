// Owner jobs, shared by the command line (admin.ts) and the Sterling Admin window (admin-ui.ts).
// They run on the owner's PC through Wrangler, signed in to Cloudflare with 2FA. There is no admin
// route on the server: these talk to D1 directly with fixed SQL. The only free text is a notice's,
// which is checked with the server's own rules and written as a hex literal (see saveNotices).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fetchUsage, fetchHealth, percentages, FREE_LIMITS } from "../src/usage";
import { parseNotices, checkNotice, MAX_NOTICES, type Notice } from "../src/notices";

export const ID = /^[0-9a-f]{16}$/;

export class AdminError extends Error {}

// The D1 database name from wrangler.toml.
function dbName(): string
{
    if (process.env.SQS_ADMIN_TEST_CONFIG) return "test";
    if (!existsSync("wrangler.toml"))
    {
        throw new AdminError("No wrangler.toml here. Copy wrangler.example.toml to wrangler.toml and fill it in first.");
    }

    const match = /database_name\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"));

    return match ? match[1] : "sterling-quest-sync";
}

/** The owner's tokens live outside the repo (and outside any synced folder): ~/.sterling-admin/admin.env. */
export function adminEnvPath(): string
{
    return process.env.SQS_ADMIN_ENV || join(homedir(), ".sterling-admin", "admin.env");
}

let envLoaded = false;

// Loads the owner's admin settings file once, without overriding real variables.
export function loadAdminEnv(): void
{
    if (envLoaded) return;

    envLoaded = true;

    for (const path of [adminEnvPath(), ".admin.env"])
    {
        if (!existsSync(path)) continue;

        for (const line of readFileSync(path, "utf8").split(/\r?\n/))
        {
            const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);

            if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
        }
    }
}

/** How Wrangler signs in: the database-only token when it's set up, otherwise your `wrangler login`. */
export function signIn(): "token" | "login"
{
    loadAdminEnv();

    return process.env.CF_D1_TOKEN && process.env.CF_ACCOUNT_ID ? "token" : "login";
}

// The environment Wrangler runs with: our token if there is one, no metrics.
function wranglerEnv(): NodeJS.ProcessEnv
{
    const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };

    // Wrangler reads CF_* as old spellings of its own settings and warns about them, so it never sees ours.
    for (const name of ["CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_D1_TOKEN"]) delete env[name];

    if (signIn() === "token")
    {
        env.CLOUDFLARE_API_TOKEN = process.env.CF_D1_TOKEN;
        env.CLOUDFLARE_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
    }

    return env;
}

/** Where the SQL runs: the live database, or a local test copy when SQS_ADMIN_TEST_CONFIG is set. */
function target(exporting = false): string[]
{
    const cfg = process.env.SQS_ADMIN_TEST_CONFIG;

    if (cfg) return exporting ? ["-c", cfg, "--local"] : ["-c", cfg, "--local", "--persist-to", process.env.SQS_ADMIN_TEST_PERSIST || ".wrangler/state"];

    return ["--remote"];
}

/** Wrangler's --json answer, even when it prints a banner or notes around it. undefined if there is none. */
function parseWranglerJson(raw: string): any
{
    const text = raw.replace(/\x1b\[[0-9;]*m/g, "");

    try { return JSON.parse(text); } catch { /* look for the JSON part */ }

    for (let i = text.indexOf("["); i >= 0; i = text.indexOf("[", i + 1))
    {
        const end = text.lastIndexOf("]");

        if (end <= i) break;

        try { return JSON.parse(text.slice(i, end + 1)); } catch { /* try the next bracket */ }
    }

    const first = text.indexOf("{"), last = text.lastIndexOf("}");

    if (first >= 0 && last > first) { try { return JSON.parse(text.slice(first, last + 1)); } catch { /* none */ } }

    return undefined;
}

/** The line of Wrangler's output that says what went wrong, without colour codes. */
function wranglerError(text: string): string
{
    const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // Warnings are never the reason it failed: skip them and everything that belongs to them.
    const useful = lines.filter((line) => !/^▲|\[WARNING\]|deprecated|Logs were written|^🪵|^-+$/i.test(line));
    const errorAt = useful.findIndex((line) => /ERROR|✘/.test(line));
    const pick = errorAt >= 0 ? useful.slice(errorAt, errorAt + 3) : useful.slice(-2);

    return (pick.join(" ").replace(/✘\s*\[ERROR\]\s*/g, "") || "Wrangler failed.").slice(0, 400);
}

// Runs SQL on the live database and returns all rows.
export async function d1(sql: string): Promise<any[]>
{
    return (await d1Sets(sql)).flat();
}

// The Worker's name from wrangler.toml.
function wranglerName(): string
{
    if (process.env.SQS_ADMIN_TEST_CONFIG) return "sterling-quest-sync-test";

    const match = existsSync("wrangler.toml") ? /^name\s*=\s*"([^"]+)"/m.exec(readFileSync("wrangler.toml", "utf8")) : null;

    return match ? match[1] : "sterling-quest-sync";
}

// The server's public address from wrangler.toml's route.
function serverUrl(): string | null
{
    if (process.env.SQS_ADMIN_TEST_URL) return process.env.SQS_ADMIN_TEST_URL;
    if (!existsSync("wrangler.toml")) return null;

    const match = /pattern\s*=\s*"([^"/*]+)"/.exec(readFileSync("wrangler.toml", "utf8"));

    return match ? "https://" + match[1] : null;
}

/**
 * Runs Wrangler directly with Node, with no shell in between, so nothing in an argument is ever
 * interpreted by cmd.exe. (A remote `--file` run goes through D1's import path, which returns no
 * rows, so queries use `--command`.)
 */
function wrangler(args: string[])
{
    const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "wrangler", "bin", "wrangler.js");

    if (!existsSync(bin)) throw new AdminError("Wrangler isn't installed in this folder. Run npm install here, then try again.");

    return spawn(process.execPath, [bin, ...args], { env: wranglerEnv(), windowsHide: true });
}

/** Runs fixed SQL and returns one result list per statement. Only fixed text, checked ids and numbers go in. */
export function d1Sets(sql: string): Promise<any[][]>
{
    const oneLine = sql.replace(/\s+/g, " ").trim();

    return new Promise((resolve, reject) =>
    {
        const child = wrangler(["d1", "execute", dbName(), ...target(), "--json", "--command", oneLine]);
        let out = "";
        let err = "";

        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", (error) =>
        {
            reject(new AdminError("Couldn't start Wrangler: " + error.message));
        });

        child.on("close", (code) =>
        {
            if (code !== 0)
            {
                const text = (err || out).trim();
                const hint = /login|auth|not authorized|10000/i.test(text)
                    ? signIn() === "token"
                        ? " The database token may have expired or been deleted. Run set-admin-token.cmd again."
                        : " Run `npx wrangler login` in this folder, or set up the database-only token with set-admin-token.cmd."
                    : "";

                return reject(new AdminError(wranglerError(text) + hint));
            }

            const parsed = parseWranglerJson(out);

            if (parsed === undefined)
            {
                const hint = out.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).filter((line) => line.trim()).slice(0, 2).join(" ").slice(0, 200);

                return reject(new AdminError("Couldn't read Wrangler's answer" + (hint ? ": " + hint : ".")));
            }

            const sets = Array.isArray(parsed) ? parsed : [parsed];

            if (sets.some((set: any) => set && set.success === false))
            {
                return reject(new AdminError("The database refused the query: " + JSON.stringify(sets.find((set: any) => set?.success === false)?.errors ?? "").slice(0, 200)));
            }

            resolve(sets.map((set: any) => set?.results ?? []));
        });
    });
}

export interface AccountRow
{
    account: string;
    characters: string;
    pairings: number;
    pcs: number;
    created: number;
    last_seen: number;
    banned: boolean;
}

// Every account, newest first, for the Accounts page.
export async function accounts(): Promise<AccountRow[]>
{
    const rows = await d1(`
    SELECT a.id, a.created_at, a.last_seen, a.banned,
      (SELECT COUNT(*) FROM keys k WHERE k.account_id = a.id) AS pcs,
      (SELECT GROUP_CONCAT(c.name, ', ') FROM characters c WHERE c.account_id = a.id) AS characters,
      (SELECT COUNT(*) FROM pairings p WHERE p.ended_at IS NULL AND (p.a_account = a.id OR p.b_account = a.id)) AS pairings
    FROM accounts a ORDER BY a.last_seen DESC LIMIT 200;`);
    return rows.map((row) =>
    ({
        account: String(row.id),
        characters: String(row.characters || ""),
        pairings: Number(row.pairings),
        pcs: Number(row.pcs),
        created: Number(row.created_at),
        last_seen: Number(row.last_seen),
        banned: !!row.banned,
    }));
}

// Bans or unbans an account.
export async function ban(id: string, banned: boolean): Promise<string>
{
    if (!ID.test(id)) throw new AdminError("Account ids are 16 characters, 0-9 and a-f.");

    const currentTime = Math.floor(Date.now() / 1000);

    if (banned)
    {
        await d1(`
      UPDATE accounts SET banned = 1 WHERE id = '${id}';
      UPDATE pairings SET ended_at = ${currentTime}, ended_reason = 'banned' WHERE ended_at IS NULL AND (a_account = '${id}' OR b_account = '${id}');
      DELETE FROM slots WHERE account_id = '${id}';
      DELETE FROM pair_codes WHERE account_id = '${id}';
      DELETE FROM link_codes WHERE account_id = '${id}';
      DELETE FROM invites WHERE account_id = '${id}';`);
        return `Banned ${id}. Its pairings are ended and its data and codes removed.`;
    }

    await d1(`UPDATE accounts SET banned = 0 WHERE id = '${id}';`);

    return `Unbanned ${id}. Old pairings stay ended; they can pair again with new codes.`;
}

// Sets sign-ups to open or invite only.
export async function signups(mode: string): Promise<string>
{
    if (mode !== "on" && mode !== "off") throw new AdminError("Sign-ups can only be on or off.");

    await d1(`UPDATE settings SET v = '${mode === "on" ? "open" : "invite"}' WHERE k = 'signups';`);

    return mode === "on" ? "Sign-ups are open." : "Sign-ups are closed. New accounts now need an invite from an existing user.";
}

// ---------------------------------------------------------------- notices
// The one place free text goes into the database. It's checked with the server's own rules, then
// written as a hex literal, so nothing typed can ever change the SQL around it.

// The notices stored on the server.
export async function notices(): Promise<Notice[]>
{
    const [stored] = await d1(`SELECT v FROM settings WHERE k = 'notices';`);

    return parseNotices(stored ? String(stored.v) : null);
}

// Writes the notice list back to the server.
async function saveNotices(list: Notice[]): Promise<void>
{
    const hex = Buffer.from(JSON.stringify(list), "utf8").toString("hex");

    if (!/^[0-9a-f]*$/.test(hex)) throw new AdminError("Couldn't encode the notices.");

    await d1(`INSERT INTO settings (k, v) VALUES ('notices', CAST(X'${hex}' AS TEXT)) ON CONFLICT (k) DO UPDATE SET v = excluded.v;`);
}

// Adds a notice after the same checks the server uses.
export async function addNotice(fields: Record<string, unknown>): Promise<string>
{
    const list = await notices();
    const now = Math.floor(Date.now() / 1000);
    const live = list.filter((notice) => notice.until == null || notice.until > now);

    if (live.length >= MAX_NOTICES) throw new AdminError(`There can be up to ${MAX_NOTICES} notices. Remove one first.`);

    const id = (now.toString(36) + "-" + Math.random().toString(36).slice(2, 6)).slice(0, 24);
    const days = Number(fields.days ?? 0);
    const raw: Record<string, unknown> =
    {
        id,
        text: fields.text,
        level: fields.level,
        from: fields.from || undefined,
        to: fields.to || undefined,
        link: fields.link || undefined,
        until: Number.isInteger(days) && days > 0 && days <= 365 ? now + days * 86400 : undefined,
    };

    const notice = checkNotice(raw);

    if (!notice)
    {
        throw new AdminError
        (
            "That notice can't be posted. Check: text 1 to 240 characters without < or >, versions like 0.1.23 (from not above to), " +
                "and a link only to github.com/SterlingAddons/... or sterlingaddons.com/...",
        );
    }

    await saveNotices([...live, notice]);

    return "Posted. Apps pick it up within a few hours, or right away when they start.";
}

// Removes a notice by id.
export async function removeNotice(id: string): Promise<string>
{
    if (!/^[a-z0-9-]{1,24}$/.test(id)) throw new AdminError("That isn't a notice id.");

    const list = await notices();

    if (!list.some((notice) => notice.id === id)) throw new AdminError("That notice is already gone.");

    await saveNotices(list.filter((notice) => notice.id !== id));

    return "Removed. Apps stop showing it at their next check.";
}

export interface Stats
{
    db: { accounts: number; active_today: number; pairings: number; slots: number; packet_bytes: number; signups: string };
    usage: null |
    {
        date: string;
        rows: { name: string; used: number; limit: number; percent: number }[];
    };

    usage_note: string | null;
}

// Totals for the command-line stats job.
export async function stats(): Promise<Stats>
{
    const [counts] = await d1(`
    SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM accounts WHERE last_seen > strftime('%s','now') - 86400) AS active_today,
      (SELECT COUNT(*) FROM pairings WHERE ended_at IS NULL) AS pairings,
      (SELECT COUNT(*) FROM slots) AS slots,
      (SELECT COALESCE(SUM(LENGTH(packet)), 0) FROM slots) AS packet_bytes,
      (SELECT v FROM settings WHERE k = 'signups') AS signups;`);
    const db =
    {
        accounts: Number(counts.accounts),
        active_today: Number(counts.active_today),
        pairings: Number(counts.pairings),
        slots: Number(counts.slots),
        packet_bytes: Number(counts.packet_bytes),
        signups: String(counts.signups),
    };

    loadAdminEnv();

    const token = process.env.CF_API_TOKEN;
    const acct = process.env.CF_ACCOUNT_ID;

    if (!token || !acct)
    {
        return { db, usage: null, usage_note: "For today's Cloudflare usage, put CF_API_TOKEN and CF_ACCOUNT_ID in .admin.env (git-ignored)." };
    }

    try
    {
        const usage = await fetchUsage(acct, token);
        const percent = percentages(usage);

        return {
            db,
            usage:
            {
                date: usage.date,
                rows:
                [
                    { name: "Requests", used: usage.requests, limit: FREE_LIMITS.requests, percent: percent.requests },
                    { name: "D1 rows read", used: usage.rowsRead, limit: FREE_LIMITS.rowsRead, percent: percent.rowsRead },
                    { name: "D1 rows written", used: usage.rowsWritten, limit: FREE_LIMITS.rowsWritten, percent: percent.rowsWritten },
                ],
            },

            usage_note: null,
        };
    }

    catch (error)
    {
        return { db, usage: null, usage_note: "Couldn't load today's usage: " + (error as Error).message };
    }
}

// ---------------------------------------------------------------- overview (one database call)

export interface Warning { text: string; fix: string }

export interface Overview
{
    server: { ok: boolean; ms: number | null; api: number | null; min_app: string | null; signups: string | null; error: string | null; url: string | null };
    db: Stats["db"] & { new_24h: number; new_7d: number; unpaired_new: number };
    cron: { last: number | null; cleanup_last: number | null; last_alert: string | null };
    /** Installs = PCs with a key (one person can have several). Versions from PCs seen in 30 days. */
    installs: { pcs: number; active_7d: number; active_30d: number; new_7d: number; versions: { version: string; pcs: number }[] };
    cleanup_preview: { unpaired_accounts: number; idle_accounts: number; old_copies: number; old_pairings: number; expired_codes: number };
    usage: Stats["usage"];
    health: null | { requests: number; errors: number; error_pct: number; cpuP50: number; cpuP99: number };
    notes: string[];
    warnings: Warning[];
}

// Asks the live server for /v1/meta and times the answer.
async function serverCheck(): Promise<Overview["server"]>
{
    const url = serverUrl();

    if (!url) return { ok: false, ms: null, api: null, min_app: null, signups: null, error: "No server address in wrangler.toml.", url };

    const startedAt = Date.now();

    try
    {
        const response = await fetch(url + "/v1/meta", { signal: AbortSignal.timeout(8000) });
        const elapsedMs = Date.now() - startedAt;

        if (!response.ok) return { ok: false, ms: elapsedMs, api: null, min_app: null, signups: null, error: "Server answered " + response.status, url };

        const meta = (await response.json()) as any;

        return { ok: true, ms: elapsedMs, api: Number(meta.api), min_app: String(meta.min_app), signups: String(meta.signups), error: null, url };
    }

    catch (error)
    {
        return { ok: false, ms: null, api: null, min_app: null, signups: null, error: "Can't reach the server: " + (error as Error).message, url };
    }
}

// Everything the Overview page shows, in one go.
export async function overview(): Promise<Overview>
{
    const DAY = 86400;
    const now = Math.floor(Date.now() / 1000);
    const [srv, sets] = await Promise.all
    ([
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
          + (SELECT COUNT(*) FROM invites WHERE expires_at < ${now})) AS expired_codes;
      SELECT (SELECT COUNT(*) FROM keys) AS pcs,
        (SELECT COUNT(*) FROM keys WHERE last_seen > ${now - 7 * DAY}) AS active_7d,
        (SELECT COUNT(*) FROM keys WHERE last_seen > ${now - 30 * DAY}) AS active_30d,
        (SELECT COUNT(*) FROM keys WHERE created_at > ${now - 7 * DAY}) AS new_7d;
      SELECT COALESCE(app_version, 'older than 0.1.25') AS version, COUNT(*) AS pcs FROM keys
        WHERE last_seen > ${now - 30 * DAY} GROUP BY app_version ORDER BY pcs DESC LIMIT 12;`),
    ]);

    const [accountStats] = sets[0];
    const [keyStats] = sets[1];
    const [pairingStats] = sets[2];
    const [installStats] = sets[3] ?? [{}];
    const out: Overview =
    {
        server: srv,
        db:
        {
            accounts: Number(accountStats.accounts), active_today: Number(accountStats.active_today), pairings: Number(accountStats.pairings), slots: Number(accountStats.slots),
            packet_bytes: Number(accountStats.packet_bytes), signups: String(accountStats.signups), new_24h: Number(accountStats.new_24h), new_7d: Number(accountStats.new_7d),
            unpaired_new: Number(accountStats.unpaired_new),
        },

        cron:
        {
            last: keyStats.cron_last ? Number(keyStats.cron_last) : null,
            cleanup_last: keyStats.cleanup_last ? Number(keyStats.cleanup_last) : null,
            last_alert: keyStats.last_alert ? String(keyStats.last_alert).slice("alerted:".length) : null,
        },

        installs:
        {
            pcs: Number(installStats.pcs ?? 0), active_7d: Number(installStats.active_7d ?? 0), active_30d: Number(installStats.active_30d ?? 0), new_7d: Number(installStats.new_7d ?? 0),
            versions: (sets[4] ?? []).map((row: any) => ({ version: String(row.version), pcs: Number(row.pcs) })),
        },

        cleanup_preview:
        {
            unpaired_accounts: Number(pairingStats.unpaired_accounts), idle_accounts: Number(pairingStats.idle_accounts), old_copies: Number(pairingStats.old_copies),
            old_pairings: Number(pairingStats.old_pairings), expired_codes: Number(pairingStats.expired_codes),
        },

        usage: null,
        health: null,
        notes: [],
        warnings: [],
    };

    loadAdminEnv();

    const token = process.env.CF_API_TOKEN || process.env.CF_D1_TOKEN;
    const acct = process.env.CF_ACCOUNT_ID;

    if (token && acct)
    {
        const [usageResult, healthResult] = await Promise.allSettled([fetchUsage(acct, token), fetchHealth(acct, token, wranglerName())]);

        if (usageResult.status === "fulfilled")
        {
            const percent = percentages(usageResult.value);

            out.usage =
            {
                date: usageResult.value.date,
                rows:
                [
                    { name: "Requests", used: usageResult.value.requests, limit: FREE_LIMITS.requests, percent: percent.requests },
                    { name: "D1 rows read", used: usageResult.value.rowsRead, limit: FREE_LIMITS.rowsRead, percent: percent.rowsRead },
                    { name: "D1 rows written", used: usageResult.value.rowsWritten, limit: FREE_LIMITS.rowsWritten, percent: percent.rowsWritten },
                ],
            };
        }

        else out.notes.push("Couldn't load today's usage: " + (usageResult.reason as Error).message);

        if (healthResult.status === "fulfilled")
        {
            const health = healthResult.value;

            out.health = { ...health, error_pct: health.requests ? (health.errors / health.requests) * 100 : 0 };
        }

        else out.notes.push("Couldn't load errors and CPU time: " + (healthResult.reason as Error).message);
    }

    else
    {
        out.notes.push("For today's usage, errors and CPU time, set up the admin token: double-click set-admin-token.cmd in this folder.");
    }

    // Warnings, each with what to do. Gold in the window.
    const warnings = out.warnings;

    if (!srv.ok) warnings.push({ text: srv.error || "The server isn't answering.", fix: "Check the Worker in the Cloudflare dashboard, then deploy again with deploy.cmd." });
    if (out.cron.last === null) warnings.push({ text: "The hourly job has never recorded a run.", fix: "Normal right after this update is deployed. If it stays empty for 2 hours, check Triggers on the Worker in Cloudflare." });

    else if (now - out.cron.last > 2 * 3600) warnings.push({ text: "The hourly job hasn't run for " + Math.round((now - out.cron.last) / 3600) + " hours, so no usage alert emails.", fix: "Check Triggers on the Worker in the Cloudflare dashboard." });

    if (out.cron.cleanup_last !== null && now - out.cron.cleanup_last > 2 * DAY) warnings.push({ text: "The daily cleanup hasn't run for " + Math.round((now - out.cron.cleanup_last) / DAY) + " days.", fix: "Check Triggers on the Worker in the Cloudflare dashboard." });

    for (const row of out.usage?.rows ?? []) if (row.percent >= 50) warnings.push({ text: `${row.name} is at ${row.percent.toFixed(0)}% of today's free limit.`, fix: "It resets at 00:00 UTC. If it keeps happening, turn on Workers Paid ($5) in Cloudflare." });

    if (out.health)
    {
        if (out.health.cpuP99 >= 7) warnings.push({ text: `Slowest requests use ${out.health.cpuP99.toFixed(1)} ms of CPU (free limit 10 ms).`, fix: "Requests over 10 ms fail on the free plan. Tell Claude, or turn on Workers Paid." });
        if (out.health.requests >= 50 && out.health.error_pct >= 5) warnings.push({ text: `${out.health.error_pct.toFixed(0)}% of today's requests ended in a server error.`, fix: "Look at the Worker's logs in the Cloudflare dashboard and tell Claude what they say." });
    }

    if (out.db.new_24h >= 20 && out.db.signups === "open") warnings.push({ text: `${out.db.new_24h} new accounts in the last 24 hours.`, fix: "If you don't know where they came from, close sign-ups on the Sign-ups page." });

    return out;
}

// ---------------------------------------------------------------- backup

/** Backups hold everyone's data, so they live outside this folder (and outside the Claude folder). */
export function backupDir(): string
{
    return process.env.SQS_ADMIN_BACKUP_DIR || join(homedir(), "Sterling Admin Backups");
}

// Exports the live database to a dated .sql file.
export function backup(): Promise<{ file: string; dir: string }>
{
    const dir = backupDir();

    mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = join(dir, `sterling-quest-sync-${stamp}.sql`);

    return new Promise((resolve, reject) =>
    {
        const child = wrangler(["d1", "export", dbName(), ...target(true), "--output", file]);
        let err = "";

        child.stderr.on("data", (chunk) => (err += chunk));
        child.stdout.on("data", (chunk) => (err += chunk));
        child.on("error", (error) => reject(new AdminError("Couldn't start Wrangler: " + error.message)));
        child.on("close", (code) =>
        {
            if (code !== 0 || !existsSync(file)) return reject(new AdminError("Backup failed: " + wranglerError(err)));

            resolve({ file, dir });
        });
    });
}
